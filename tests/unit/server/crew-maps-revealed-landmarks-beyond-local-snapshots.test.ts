/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { MapAssets } from '../../../server/world/MapAssets';
import { WorldStore } from '../../../server/world/WorldStore';
import { ExplorationMap } from '../../../shared/exploration';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import type { LootData } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';

test('the global map shares the street plan while each pilot receives only nearby asteroid geometry', () => {
  const distantLot = CIVIC_LOTS.find((lot) => lot.ring === 3);
  if (!distantLot) {
    throw new Error('Expected an outer street lot');
  }
  const distant = distantLot.position;
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const nearSocket = new RecordingSocket();
  const farSocket = new RecordingSocket();
  engine.addPlayer('near', 'Near', nearSocket, { x: 0, y: 0 }, 'hauler');
  const scout = engine.addPlayer('far', 'Far', farSocket, distant, 'surveyor');
  broadcaster.negotiateSnapshot(nearSocket);
  broadcaster.negotiateSnapshot(farSocket);
  expect(engine.getGameState().mapAssets).toContainEqual({
    id: `furnace:${TOWN_HEARTH.id}`,
    name: TOWN_HEARTH.name,
    kind: 'furnace',
    position: TOWN_HEARTH.position,
  });
  expect(engine.getGameState().mapAssets).toContainEqual({
    id: `furnace:${distantLot.id}`,
    name: distantLot.name,
    kind: 'foundation',
    position: distant,
  });
  engine.tickAbilities();
  broadcaster.broadcastGameState();
  const nearRaw = nearSocket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
  const farRaw = farSocket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
  assert(nearRaw && farRaw);
  const near = decodeSnapshotMessage(new SnapshotDecoder(), nearRaw);
  const far = decodeSnapshotMessage(new SnapshotDecoder(), farRaw);
  expect(near.mapAssets).toEqual(far.mapAssets);
  expect(near.mapAssets).toContainEqual({
    id: `furnace:${distantLot.id}`,
    name: distantLot.name,
    kind: 'foundation',
    position: distant,
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
        Math.abs(rock.position.x - distant.x) <= 2800 &&
        Math.abs(rock.position.y - distant.y) <= 2800
    )
  ).toBe(true);
  expect(
    new Set(near.asteroids.map((rock) => rock.id)).intersection(
      new Set(far.asteroids.map((rock) => rock.id))
    ).size
  ).toBe(0);
  scout.position = { x: 0, y: 0 };
  engine.ensureAsteroidField();
  expect(
    engine.getGameState().mapAssets.filter((asset) => asset.kind === 'foundation')
  ).toHaveLength(CIVIC_LOTS.length);
});

test('valuable drops appear only after exploration and disappear when collected without mapping ordinary shards', () => {
  const assets = new MapAssets();
  const exploration = new ExplorationMap();
  const drops: LootData[] = [
    { id: 'core', kind: 'laserCore', position: { x: 40_000, y: 24_000 }, radius: 10, mass: 0 },
    { id: 'fragment', kind: 'shard', position: { x: 40_000, y: 24_000 }, radius: 5, mass: 0.25 },
    { id: 'canister', kind: 'tap', position: { x: 40_000, y: 24_000 }, radius: 28, mass: 0.4 },
  ];
  const cold = assets.snapshot(exploration.snapshot(), drops, []);
  expect(cold.every((asset) => asset.kind === 'furnace' || asset.kind === 'foundation')).toBe(true);
  expect(cold.some((asset) => asset.id === 'loot:core')).toBe(false);
  exploration.reveal(drops[0]?.position ?? { x: 0, y: 0 }, 260);
  const revealed = assets.snapshot(exploration.snapshot(), drops, []);
  expect(revealed.some((asset) => asset.id === 'loot:core')).toBe(true);
  expect(revealed.some((asset) => asset.id === 'loot:fragment')).toBe(false);
  expect(revealed.some((asset) => asset.id === 'loot:canister')).toBe(false);
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
      },
      new Map(),
      []
    );
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    engine.addPlayer('late', 'Late explorer', socket, { x: 0, y: 0 });
    const broadcaster = new GameStateBroadcaster(engine);
    broadcaster.negotiateSnapshot(socket);
    broadcaster.broadcastGameState();
    const first = socket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
    assert(first, 'a complete atlas must fit the snapshot transport');
    const decoded = decodeSnapshotMessage(new SnapshotDecoder(), first);
    expect(decoded.exploration).toEqual(exploration.snapshot());
    expect(decoded.mapAssets.filter((asset) => asset.kind === 'furnace')).toContainEqual(
      expect.objectContaining({ id: `furnace:${TOWN_HEARTH.id}` })
    );
    expect(decoded.mapAssets.filter((asset) => asset.kind === 'foundation').length).toBe(
      CIVIC_LOTS.length
    );
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
