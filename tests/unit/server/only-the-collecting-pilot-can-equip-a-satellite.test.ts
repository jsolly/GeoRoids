/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { WireClient } from '../../support/wireClient';

test("a socket cannot impersonate the collector or equip someone else's inventory", async () => {
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const port = await server.listening;
  const owner = new WireClient(new WebSocket(`ws://localhost:${port}/ws?asteroidInteractions=1`));
  const other = new WireClient(new WebSocket(`ws://localhost:${port}/ws?asteroidInteractions=1`));
  try {
    await Promise.all([owner.open(), other.open()]);
    for (const [client, id] of [
      [owner, 'owner'],
      [other, 'other'],
    ] as const) {
      client.send({ type: 'join', id, name: id, snapshotVersion: 1, asteroidInteractions: 1 });
      await client.barrier();
    }
    server.gameEngine.stopGameLoop();
    server.wsCore.stopPeriodicGameStateBroadcast();
    const pickup = server.gameEngine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    server.gameEngine.updatePlayer('owner', {
      position: { x: pickup.position.x + 110, y: pickup.position.y },
    });
    server.gameEngine.updatePlayer('other', { position: { x: 4000, y: 0 } });
    server.gameEngine.tickSatellitePickups();
    expect(server.gameEngine.getSatellitePickup(pickup.id)).toMatchObject({
      state: 'stored',
      ownerId: 'owner',
    });
    other.send({ type: 'equipSatellite', id: 'owner', data: { pickupId: pickup.id } });
    await other.barrier();
    expect(server.gameEngine.getSatellitePickup(pickup.id)?.state).toBe('stored');
    other.send({ type: 'equipSatellite', id: 'other', data: { pickupId: pickup.id } });
    await other.barrier();
    expect(server.gameEngine.getSatellitePickup(pickup.id)?.state).toBe('stored');
    owner.send({ type: 'equipSatellite', id: 'owner', data: { pickupId: pickup.id } });
    await owner.barrier();
    expect(server.gameEngine.getSatellitePickup(pickup.id)?.state).toBe('orbiting');
  } finally {
    await Promise.all([owner.close(), other.close()]);
    await server.close();
  }
});
