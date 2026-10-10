/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SNAPSHOT_BACKPRESSURE_BYTES, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { launchUtilityFlight } from '../../../shared/utilityFlight';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

test('a broadcast with only pressured recipients prepares no common projectile rows', () => {
  const engine = new GameEngine(82);
  const socket = new RecordingSocket();
  const broadcaster = new GameStateBroadcaster(engine);
  const projectiles = vi.spyOn(engine, 'getPlayerProjectiles');
  try {
    engine.addPlayer('waiting', 'Waiting', socket, { x: 0, y: 0 });
    broadcaster.negotiateSnapshot(socket);
    socket.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    broadcaster.broadcastGameState();
    expect(projectiles).not.toHaveBeenCalled();
    expect(socket.received('snapshot')).toEqual([]);
    expect(socket.readyState).toBe(socket.OPEN);
  } finally {
    projectiles.mockRestore();
    engine.stopGameLoop();
  }
});

test.each(['tow', 'probe'] as const)(
  'a %s flight enters and leaves an observer interest square while its owner keeps seeing it',
  (kind) => {
    const engine = new GameEngine(82);
    const broadcaster = new GameStateBroadcaster(engine);
    const ownerSocket = new RecordingSocket();
    const observerSocket = new RecordingSocket();
    try {
      engine.addPlayer('owner', 'Owner', ownerSocket, { x: 10000, y: 0 });
      engine.addPlayer('observer', 'Observer', observerSocket, { x: 0, y: 0 });
      const owner = engine.getPlayer('owner');
      assert(owner);
      owner.angle = 0.2;
      owner.utilityFlight = launchUtilityFlight(owner, kind, 20, 700);
      broadcaster.negotiateSnapshot(ownerSocket);
      broadcaster.negotiateSnapshot(observerSocket);
      const ownerDecoder = new SnapshotDecoder();
      const observerDecoder = new SnapshotDecoder();
      const ownerRow = (socket: RecordingSocket, decoder: SnapshotDecoder) => {
        const raw = socket.sent.at(-1);
        assert(raw);
        const applied = decoder.readMessage(raw, { acceptSnapshots: true });
        assert(applied.kind === 'snapshot');
        expect(broadcaster.acknowledgeSnapshot(socket, applied.metadata.sequence)).toBe(true);
        return applied.state.entities.find((entity) => entity.id === owner.id);
      };

      broadcaster.broadcastGameState();
      expect(ownerRow(ownerSocket, ownerDecoder)?.utilityFlight).toEqual(owner.utilityFlight);
      expect(ownerRow(observerSocket, observerDecoder)?.utilityFlight).toBeNull();

      // The tip, rather than its distant pilot, determines observer visibility.
      owner.utilityFlight.position = { x: WORLD.interestRadius, y: 0 };
      broadcaster.broadcastGameState();
      expect(ownerRow(ownerSocket, ownerDecoder)?.utilityFlight).toEqual(owner.utilityFlight);
      expect(ownerRow(observerSocket, observerDecoder)?.utilityFlight).toEqual(owner.utilityFlight);

      owner.utilityFlight.position.x++;
      broadcaster.broadcastGameState();
      expect(ownerRow(ownerSocket, ownerDecoder)?.utilityFlight).toEqual(owner.utilityFlight);
      expect(ownerRow(observerSocket, observerDecoder)?.utilityFlight).toBeNull();
      expect(observerSocket.lastReceived('snapshot')?.data).toMatchObject({ kind: 'delta' });
      expect(owner.utilityFlight).not.toBeNull();
    } finally {
      engine.stopGameLoop();
    }
  }
);
