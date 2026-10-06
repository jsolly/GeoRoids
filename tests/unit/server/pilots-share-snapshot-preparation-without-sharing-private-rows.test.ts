/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SNAPSHOT_BACKPRESSURE_BYTES, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { launchUtilityFlight } from '../../../shared/utilityFlight';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';

function rock(id: string, x: number): AsteroidData {
  return {
    id,
    position: { x, y: 200 },
    velocity: { x: 0, y: 0 },
    size: 50,
    offsets: [1, 1, 1, 1],
    vertices: 4,
    jaggedness: 0,
    health: 75,
    maxHealth: 75,
    rotation: 0,
    angularVelocity: 0,
    material: 'ice',
  };
}

function latestSnapshot(socket: RecordingSocket, decoder: SnapshotDecoder) {
  const raw = socket.sent.at(-1);
  assert(raw, 'pilot received a snapshot');
  return decodeSnapshotMessage(decoder, raw);
}

test('three pilots share preparation while receiving their own nearby shots, tags and eligible equipment', () => {
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const near = new RecordingSocket();
  const far = new RecordingSocket();
  const scout = new RecordingSocket();
  const clock = vi.spyOn(engine, 'getServerTime').mockReturnValue(engine.getServerTime());
  const projectiles = vi.spyOn(engine, 'getPlayerProjectiles');
  const tags = vi.spyOn(engine, 'getActiveCollabTags');
  try {
    engine.addPlayer('near', 'Near', near, { x: 0, y: 0 }, 'hauler');
    engine.addPlayer('far', 'Far', far, { x: 10000, y: 0 }, 'hauler');
    engine.addPlayer('scout', 'Scout', scout, { x: 50, y: 0 }, 'scout');
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
    engine.addAsteroid(rock('near-rock', 0));
    engine.addAsteroid(rock('far-rock', 10000));
    expect(engine.handleAsteroidHit('near-rock', 'near').outcome).toBe('tagged');
    expect(engine.handleAsteroidHit('far-rock', 'far').outcome).toBe('tagged');
    const nearShot = engine.spawnLaser('near', { x: 12, y: 0 }, { x: 5, y: 0 });
    const farShot = engine.spawnLaser('far', { x: 10012, y: 0 }, { x: 5, y: 0 });
    assert(nearShot && farShot, 'both pilots fired');
    const tap = engine.dropEquipmentAt({ x: 100, y: 0 }, 'resource_tap');
    const probe = engine.dropEquipmentAt({ x: 100, y: 0 }, 'survey_probe');
    for (const socket of [near, far, scout]) {
      broadcaster.negotiateSnapshot(socket);
    }
    projectiles.mockClear();
    tags.mockClear();
    const nearDecoder = new SnapshotDecoder();
    const farDecoder = new SnapshotDecoder();
    const scoutDecoder = new SnapshotDecoder();
    broadcaster.broadcastGameState();
    expect(projectiles).toHaveBeenCalledTimes(1);
    expect(tags).toHaveBeenCalledTimes(1);
    const nearWorld = latestSnapshot(near, nearDecoder);
    const farWorld = latestSnapshot(far, farDecoder);
    const scoutWorld = latestSnapshot(scout, scoutDecoder);
    expect(nearWorld.playerProjectiles.map((shot) => shot.id)).toEqual([nearShot.id]);
    expect(farWorld.playerProjectiles.map((shot) => shot.id)).toEqual([farShot.id]);
    expect(scoutWorld.playerProjectiles.map((shot) => shot.id)).toEqual([nearShot.id]);
    expect(nearWorld.collabTags.map((tag) => tag.asteroidId)).toEqual(['near-rock']);
    expect(farWorld.collabTags.map((tag) => tag.asteroidId)).toEqual(['far-rock']);
    expect(nearWorld.loot.map((drop) => drop.id)).toEqual([tap.id]);
    expect(scoutWorld.loot.map((drop) => drop.id)).toEqual([probe.id]);
    expect(farWorld.loot).toEqual([]);

    far.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    const farSnapshots = far.received('snapshot').length;
    nearShot.position.x += 20;
    broadcaster.broadcastGameState();
    expect(projectiles).toHaveBeenCalledTimes(2);
    expect(tags).toHaveBeenCalledTimes(2);
    expect(far.received('snapshot')).toHaveLength(farSnapshots);
    expect(latestSnapshot(near, nearDecoder).playerProjectiles[0]?.position.x).toBe(32);
    latestSnapshot(scout, scoutDecoder);
    far.bufferedAmount = 0;
    broadcaster.broadcastGameState();
    expect(projectiles).toHaveBeenCalledTimes(3);
    expect(tags).toHaveBeenCalledTimes(3);
    expect(far.lastReceived('snapshot')?.data).toMatchObject({
      sequence: 2,
      kind: 'delta',
      baseline: 1,
    });
    expect(latestSnapshot(far, farDecoder).playerProjectiles.map((shot) => shot.id)).toEqual([
      farShot.id,
    ]);
  } finally {
    projectiles.mockRestore();
    tags.mockRestore();
    clock.mockRestore();
    engine.stopGameLoop();
  }
});

test('a broadcast with only pressured recipients prepares no common projectile or tag rows', () => {
  const engine = new GameEngine(82);
  const socket = new RecordingSocket();
  const broadcaster = new GameStateBroadcaster(engine);
  const projectiles = vi.spyOn(engine, 'getPlayerProjectiles');
  const tags = vi.spyOn(engine, 'getActiveCollabTags');
  try {
    engine.addPlayer('waiting', 'Waiting', socket, { x: 0, y: 0 });
    broadcaster.negotiateSnapshot(socket);
    socket.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
    broadcaster.broadcastGameState();
    expect(projectiles).not.toHaveBeenCalled();
    expect(tags).not.toHaveBeenCalled();
    expect(socket.received('snapshot')).toEqual([]);
    expect(socket.readyState).toBe(socket.OPEN);
  } finally {
    projectiles.mockRestore();
    tags.mockRestore();
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
