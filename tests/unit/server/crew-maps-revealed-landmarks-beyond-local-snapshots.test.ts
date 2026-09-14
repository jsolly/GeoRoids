import { strict as assert } from 'node:assert';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { MapAssets } from '../../../server/world/MapAssets';
import { WorldStore } from '../../../server/world/WorldStore';
import { ExplorationMap } from '../../../shared/exploration';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import type { LootData } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';

test('the global map shares a distant furnace while each pilot receives only nearby asteroid geometry', () => {
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const nearSocket = new RecordingSocket();
  const farSocket = new RecordingSocket();
  engine.addPlayer('near', 'Near', nearSocket, { x: 0, y: 0 }, 'hauler');
  const scout = engine.addPlayer('far', 'Far', farSocket, { x: 40_000, y: 24_000 }, 'surveyor');
  broadcaster.negotiateSnapshot(nearSocket);
  broadcaster.negotiateSnapshot(farSocket);
  expect(engine.getGameState().mapAssets.some((asset) => asset.id === 'furnace:works-10-6')).toBe(
    false
  );
  engine.tickAbilities();
  broadcaster.broadcastGameState();
  const nearRaw = nearSocket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
  const farRaw = farSocket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
  assert(nearRaw && farRaw);
  const near = decodeSnapshotMessage(new SnapshotDecoder(), nearRaw);
  const far = decodeSnapshotMessage(new SnapshotDecoder(), farRaw);
  expect(near.mapAssets).toEqual(far.mapAssets);
  expect(near.mapAssets).toContainEqual({
    id: 'furnace:works-10-6',
    name: 'Works 10:6',
    kind: 'furnace',
    position: { x: 40_000, y: 24_000 },
  });
  expect(near.asteroids.length).toBeGreaterThan(0);
  expect(far.asteroids.length).toBeGreaterThan(0);
  expect(
    near.asteroids.every(
      (rock) => Math.abs(rock.position.x) <= 2800 && Math.abs(rock.position.y) <= 2800
    )
  ).toBe(true);
  expect(
    far.asteroids.every(
      (rock) =>
        Math.abs(rock.position.x - 40_000) <= 2800 && Math.abs(rock.position.y - 24_000) <= 2800
    )
  ).toBe(true);
  expect(
    new Set(near.asteroids.map((rock) => rock.id)).intersection(
      new Set(far.asteroids.map((rock) => rock.id))
    ).size
  ).toBe(0);
  scout.position = { x: 0, y: 0 };
  engine.ensureAsteroidField();
  expect(engine.getGameState().mapAssets.some((asset) => asset.id === 'furnace:works-10-6')).toBe(
    true
  );
});

test('valuable drops appear only after exploration and disappear when collected without mapping ordinary shards', () => {
  const assets = new MapAssets();
  const exploration = new ExplorationMap();
  const drops: LootData[] = [
    { id: 'core', kind: 'laserCore', position: { x: 40_000, y: 24_000 }, radius: 10, mass: 0 },
    { id: 'fragment', kind: 'shard', position: { x: 40_000, y: 24_000 }, radius: 5, mass: 0.25 },
  ];
  expect(assets.snapshot(exploration.snapshot(), drops, [])).toEqual([]);
  exploration.reveal(drops[0]?.position ?? { x: 0, y: 0 }, 260);
  const revealed = assets.snapshot(exploration.snapshot(), drops, []);
  expect(revealed.some((asset) => asset.id === 'loot:core')).toBe(true);
  expect(revealed.some((asset) => asset.id === 'loot:fragment')).toBe(false);
  expect(
    assets.snapshot(exploration.snapshot(), [], []).some((asset) => asset.id === 'loot:core')
  ).toBe(false);
});

test('a pilot can join and resynchronize after the crew has explored the entire universe', () => {
  const exploration = new ExplorationMap();
  exploration.reveal({ x: 0, y: 0 }, 60_000);
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: 82,
        startedAt: 1,
        generation: WORLD.generation,
        exploration: exploration.snapshot(),
        completedSectors: [],
      },
      new Map(),
      []
    );
    const engine = new GameEngine(82, undefined, store);
    const socket = new RecordingSocket();
    engine.addPlayer('late', 'Late explorer', socket, { x: 0, y: 0 });
    const broadcaster = new GameStateBroadcaster(engine);
    broadcaster.negotiateSnapshot(socket);
    broadcaster.broadcastGameState();
    const first = socket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
    assert(first, 'a complete atlas must fit the snapshot transport');
    const decoded = decodeSnapshotMessage(new SnapshotDecoder(), first);
    expect(decoded.exploration).toEqual(exploration.snapshot());
    expect(decoded.mapAssets.length).toBeGreaterThan(600);
    expect(decoded.asteroids.length).toBeGreaterThan(0);
    expect(socket.readyState).toBe(1);

    socket.sent.length = 0;
    broadcaster.negotiateSnapshot(socket);
    broadcaster.broadcastGameState();
    const recovered = socket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
    assert(recovered, 'resynchronization must also send a complete atlas');
    expect(decodeSnapshotMessage(new SnapshotDecoder(), recovered).exploration).toEqual(
      decoded.exploration
    );
    expect(socket.readyState).toBe(1);
  } finally {
    store.close();
  }
});
