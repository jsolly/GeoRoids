/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { SATELLITE_PICKUP } from '../../../src/constants';

describe('Server scoring via satellitePickupCollected', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  let client: WebSocket | null = null;

  afterEach(async () => {
    try {
      client?.terminate();
      if (server) {
        await server.close();
      }
    } finally {
      server = null;
      client = null;
    }
  });

  test('awards points and broadcasts the collect event', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;
    const ws = new WebSocket(`ws://localhost:${port}/ws?asteroidInteractions=1`);
    client = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    const playerId = 'p1-pickup';
    ws.send(
      JSON.stringify({
        type: 'join',
        id: playerId,
        name: 'Collector',
        snapshotVersion: 1,
        asteroidInteractions: 1,
      })
    );
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();

    const pickup = await new Promise<{ id: string; x: number; y: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for pickups')), 5000);
      const decoder = new SnapshotDecoder();
      ws.on('message', (raw) => {
        try {
          const packet = JSON.parse(String(raw));
          if (packet?.type === 'joined') {
            decoder.reset();
          }
          const msg =
            packet?.type === 'snapshot' ? { ...packet, data: decoder.decode(packet.data) } : packet;
          const list = msg?.data?.satellitePickups;
          if (msg?.type === 'snapshot' && Array.isArray(list) && list.length > 0) {
            clearTimeout(timeout);
            resolve({ id: list[0].id, x: list[0].position.x, y: list[0].position.y });
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });

    const collector = server.gameEngine.getPlayer(playerId);
    expect(collector?.asteroidMotion).toBeDefined();
    expect(
      server.gameEngine.asteroidMotion.placeActorForTesting(
        playerId,
        { x: pickup.x, y: pickup.y },
        server.gameEngine.getServerTime()
      )
    ).toBe(true);
    ws.send(
      JSON.stringify({
        type: 'update',
        id: playerId,
        data: {
          position: { x: pickup.x, y: pickup.y },
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
          motionEpoch: collector?.asteroidMotion?.epoch,
          motionSequence: 0,
        },
      })
    );
    ws.send(
      JSON.stringify({
        type: 'satellitePickupCollected',
        pickupId: pickup.id,
        playerId,
      })
    );

    const collected = await new Promise<{ score: number; pickupName: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for collect')), 5000);
        let score = -1;
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg?.type === 'scoreUpdate' && msg?.data?.playerId === playerId) {
              score = msg.data.score;
            }
            if (msg?.type === 'satellitePickupCollected' && msg?.data?.playerId === playerId) {
              clearTimeout(timeout);
              resolve({
                score: score >= 0 ? score : msg.data.scoreBonus,
                pickupName: msg.data.pickupName,
              });
            }
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      }
    );

    expect(collected.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(collected.pickupName).toMatch(/Echo|Relay/);

    ws.close();
  });
});
