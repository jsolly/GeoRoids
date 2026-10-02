/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { SNAPSHOT_BACKPRESSURE_BYTES, SnapshotDecoder } from '../../../shared/snapshotProtocol';
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
