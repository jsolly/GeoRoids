/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { AI_SHIPS } from '../../../shared/aiShips';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

test('a real pilot receives both bot factions and cannot steer or claim either ship', async () => {
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const clients: WireClient[] = [];
  try {
    await server.listening;
    server.gameEngine.stopGameLoop();
    const wire = new WireClient(
      new WebSocket(
        `ws://127.0.0.1:${server.getPort()}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`
      )
    );
    clients.push(wire);
    const decoder = new SnapshotDecoder();
    const snapshots: ServerGameSnapshot[] = [];
    wire.ws.on('message', (raw) => {
      try {
        const result = decoder.readMessage(String(raw), { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'snapshot') {
          snapshots.push(result.state);
          wire.send({ type: 'snapshotAck', data: { sequence: result.metadata.sequence } });
        }
      } catch (error) {
        wire.failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    });
    await wire.open();
    wire.send({
      type: 'join',
      id: 'human',
      data: {
        name: 'Human',
        position: { x: 0, y: 0 },
        kitId: 'scout',
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    });
    await wire.waitFor(
      () => wire.messages.find((message) => message.type === 'joined'),
      'real join'
    );
    const pilot = server.gameEngine.getPlayer('human');
    assert(pilot);
    pilot.overlayHold = true;
    for (let index = 0; index < AI_SHIPS.spawnDelayFrames; index++) {
      server.gameEngine.advanceOneFrame();
    }
    server.wsCore.getBroadcaster().broadcastGameState();
    const state = await wire.waitFor(
      () => snapshots.find((snapshot) => snapshot.entities.some((row) => row.botRole === 'raider')),
      'both bot factions on the wire'
    );
    expect(
      state.entities
        .filter((row) => row.botRole)
        .map((row) => row.botRole)
        .sort()
    ).toEqual(['raider', 'worker']);
    const worker = state.entities.find((row) => row.botRole === 'worker');
    assert(worker);
    const actor = server.gameEngine.getPlayer(worker.id);
    assert(actor);
    const before = { ...actor.position };
    wire.send({
      type: 'update',
      id: worker.id,
      data: {
        position: { x: 40_000, y: 40_000 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: false,
      },
    });
    await wire.barrier();
    expect(actor.position).toEqual(before);
    expect(actor.ws).toBeUndefined();
    expect(server.gameEngine.hasSavedPilot(worker.id)).toBe(false);
    expect(server.gameEngine.getPlayerCount()).toBe(1);
    wire.assertHealthy();
  } finally {
    await closePlayerMotionScenario({ clients, server });
  }
});
