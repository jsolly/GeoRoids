/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SATELLITE_PICKUP } from '../../../src/constants';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('Server scoring via automatic satellite pickup collection', () => {
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

  test('awards points and broadcasts the collect event without a client claim', async () => {
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
    await expect.poll(() => server?.gameEngine.getPlayer(playerId)).toBeDefined();
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();

    const pickup = server.gameEngine.getAllSatellitePickups()[0];
    const collector = server.gameEngine.getPlayer(playerId);
    expect(pickup).toBeDefined();
    expect(collector).toBeDefined();
    if (!pickup || !collector) {
      throw new Error('join did not create the pickup test fixture');
    }

    const event = new Promise<{ type: string; data: Record<string, unknown> }>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for collect event')),
          5000
        );
        ws.on('message', (raw) => {
          try {
            const packet: unknown = JSON.parse(String(raw));
            if (
              typeof packet === 'object' &&
              packet !== null &&
              'type' in packet &&
              packet.type === 'satellitePickupCollected' &&
              'data' in packet &&
              isRecord(packet.data)
            ) {
              clearTimeout(timeout);
              resolve({ type: packet.type, data: packet.data });
            }
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      }
    );

    server.gameEngine.updatePlayer(playerId, {
      position: { x: pickup.position.x + 110, y: pickup.position.y },
      spawnProtectionTimer: 0,
    });
    server.gameEngine.tickSatellitePickups();

    expect(server.gameEngine.getPlayer(playerId)?.score).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(server.gameEngine.getSatellitePickup(pickup.id)?.ownerId).toBe(playerId);
    server.wsCore.getBroadcaster().broadcastGameState();

    const collected = await event;
    expect(collected.type).toBe('satellitePickupCollected');
    expect(collected.data['playerId']).toBe(playerId);
    expect(collected.data['pickupId']).toBe(pickup.id);
    expect(collected.data['scoreBonus']).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(collected.data).not.toHaveProperty('shieldFrames');
  });
});
