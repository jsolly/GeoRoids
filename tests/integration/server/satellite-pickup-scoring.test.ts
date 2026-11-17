/* @vitest-environment node */

import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SATELLITE_PICKUP } from '../../../shared/constants/gameplay';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('Server scoring via automatic satellite pickup collection', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  let client: WireClient | null = null;

  afterEach(async () => {
    try {
      await closePlayerMotionScenario({
        clients: client ? [client] : [],
        server: server ?? undefined,
      });
      client?.assertHealthy();
    } finally {
      server = null;
      client = null;
    }
  });

  test('awards points and broadcasts the collect event without a client claim', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;
    const ws = new WebSocket(
      `ws://localhost:${port}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1&explorationVersion=1`
    );
    client = new WireClient(ws);
    await client.open();

    const playerId = 'p1-pickup';
    client.send({
      type: 'join',
      id: playerId,
      name: 'Collector',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      explorationVersion: 1,
    });
    await client.barrier();
    expect(client.messages.find((message) => message.type === 'joined')?.data).toMatchObject({
      id: playerId,
    });
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();

    const pickup = server.gameEngine.getAllSatellitePickups()[0];
    const collector = server.gameEngine.getPlayer(playerId);
    expect(pickup).toBeDefined();
    expect(collector).toBeDefined();
    if (!pickup || !collector) {
      throw new Error('join did not create the pickup test fixture');
    }

    const beforeCollection = client.mark();

    server.gameEngine.updatePlayer(playerId, {
      position: { x: pickup.position.x + 110, y: pickup.position.y },
      spawnProtectionTimer: 0,
    });
    server.gameEngine.satelliteField.advance();

    expect(server.gameEngine.getPlayer(playerId)?.cargo).toBe(SATELLITE_PICKUP.SCORE_BONUS);
    expect(server.gameEngine.getSatellitePickup(pickup.id)?.ownerId).toBe(playerId);
    server.wsCore.getBroadcaster().broadcastGameState();

    await client.barrier();
    const collected = client.messages
      .slice(beforeCollection)
      .find((message) => message.type === 'satellitePickupCollected');
    if (!collected || !isRecord(collected.data)) {
      throw new Error('Missing collection event');
    }
    expect(collected.type).toBe('satellitePickupCollected');
    expect(collected.data['playerId']).toBe(playerId);
    expect(collected.data['pickupId']).toBe(pickup.id);
    const source = collected.data['position'];
    if (!isRecord(source) || typeof source['x'] !== 'number' || typeof source['y'] !== 'number') {
      throw new Error('Collection event must include its world position');
    }
    expect(
      Math.hypot(source['x'] - collector.position.x, source['y'] - collector.position.y)
    ).toBeLessThanOrEqual(SATELLITE_PICKUP.AUTO_COLLECT_RANGE);
    expect(collected.data['scoreBonus']).toBe(SATELLITE_PICKUP.SCORE_BONUS);
  });
});
