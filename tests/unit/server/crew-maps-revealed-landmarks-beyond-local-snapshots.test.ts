/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { MapAssets } from '../../../server/world/MapAssets';
import { WorldStore } from '../../../server/world/WorldStore';
import { emptySettlement } from '../../../shared/economy';
import { ExplorationMap } from '../../../shared/exploration';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import type { LootData } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';

test('the global map shares the furnace plan while each pilot receives only nearby asteroid geometry', () => {
  const distantLot = CIVIC_LOTS.find((lot) => lot.ring === 3);
  if (!distantLot) {
    throw new Error('Expected an outer furnace lot');
  }
  const distant = distantLot.position;
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const nearSocket = new RecordingSocket();
  const farSocket = new RecordingSocket();
  engine.addPlayer('near', 'Near', nearSocket, { x: 0, y: 0 }, 'hauler');
  const scout = engine.addPlayer('far', 'Far', farSocket, distant, 'scout');
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
  const exploration = new ExplorationMap();
  const assets = new MapAssets(exploration);
  const drops: LootData[] = [
    { id: 'salvage', kind: 'wreckage', position: { x: 40_000, y: 24_000 }, radius: 10, mass: 0 },
    { id: 'fragment', kind: 'shard', position: { x: 40_000, y: 24_000 }, radius: 5, mass: 0.25 },
    { id: 'canister', kind: 'tap', position: { x: 40_000, y: 24_000 }, radius: 28, mass: 0.4 },
  ];
  drops.forEach((drop, order) => {
    assets.changed(drop, order);
  });
  const cold = assets.snapshot([]);
  expect(cold.every((asset) => asset.kind === 'furnace' || asset.kind === 'foundation')).toBe(true);
  expect(cold.some((asset) => asset.id === 'loot:salvage')).toBe(false);
  exploration.reveal(drops[0]?.position ?? { x: 0, y: 0 }, 260);
  assets.discovered('salvage');
  const revealed = assets.snapshot([]);
  expect(revealed.some((asset) => asset.id === 'loot:salvage')).toBe(true);
  expect(revealed.some((asset) => asset.id === 'loot:fragment')).toBe(false);
  expect(revealed.some((asset) => asset.id === 'loot:canister')).toBe(false);
  assets.removed('salvage');
  expect(assets.snapshot([]).some((asset) => asset.id === 'loot:salvage')).toBe(false);
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

function point(id: string, x = 40, y = 40): LootData {
  return { id, kind: 'points', position: { x, y }, radius: 14, mass: 0, points: 100 };
}
function salvageIds(assets: MapAssets): string[] {
  return assets
    .snapshot([])
    .filter((asset) => asset.kind === 'wreckage')
    .map((asset) => asset.id);
}

test('salvage knowledge changes at observation, survives movement into fog and ends on observed removal', () => {
  const exploration = new ExplorationMap();
  exploration.reveal({ x: 40, y: 40 }, 260);
  const assets = new MapAssets(exploration);
  const initial = point('cargo');
  assets.changed(initial, 0);
  assets.primeInitialLoot();
  // Crossing revealed space before observation does not reveal the final fog position.
  const hidden = point('cargo', 40000, 24000);
  assets.moved(hidden);
  expect(salvageIds(assets)).toEqual([]);
  assets.moved(initial);
  expect(salvageIds(assets)).toEqual(['loot:cargo']);
  assets.moved(hidden);
  expect(assets.snapshot([])).toContainEqual({
    id: 'loot:cargo',
    kind: 'wreckage',
    position: hidden.position,
    name: 'Salvage',
  });
  // Removal and replacement between observations preserve the existing known ID.
  assets.removed('cargo');
  assets.changed(hidden, 1);
  expect(salvageIds(assets)).toEqual(['loot:cargo']);
  assets.removed('cargo');
  expect(salvageIds(assets)).toEqual([]);
  assets.changed(hidden, 2);
  expect(salvageIds(assets)).toEqual([]);
  assets.reset();
  assets.changed(hidden, 0);
  expect(salvageIds(assets)).toEqual([]);
});

test('startup candidates do not reveal a removed and replaced fog drop before the first snapshot', () => {
  const exploration = new ExplorationMap();
  exploration.reveal({ x: 40, y: 40 }, 260);
  const assets = new MapAssets(exploration);
  assets.changed(point('cargo'), 0);
  assets.primeInitialLoot();
  assets.removed('cargo');
  assets.changed(point('cargo', 40000, 24000), 1);
  expect(salvageIds(assets)).toEqual([]);
});

test('equal Unicode loot IDs retain authoritative insertion order regardless of discovery or replacement order', () => {
  const exploration = new ExplorationMap();
  exploration.reveal({ x: 40, y: 40 }, 260);
  const assets = new MapAssets(exploration);
  const first = point('é');
  const second = point('e\u0301');
  expect(first.id.localeCompare(second.id)).toBe(0);
  assets.changed(second, 1);
  assets.changed(first, 0);
  expect(salvageIds(assets)).toEqual(['loot:é', 'loot:e\u0301']);
  assets.changed({ ...first, kind: 'shard' }, 0);
  assets.changed(first, 0);
  expect(salvageIds(assets)).toEqual(['loot:é', 'loot:e\u0301']);
  assets.removed(first.id);
  assets.changed(first, 2);
  expect(salvageIds(assets)).toEqual(['loot:e\u0301', 'loot:é']);
  const detached = assets.snapshot([]).find((asset) => asset.id === 'loot:é');
  assert(detached);
  detached.position.x = 999;
  expect(assets.snapshot([]).find((asset) => asset.id === 'loot:é')?.position.x).toBe(40);
});

test.each([0, 10000])(
  'local snapshots and frames avoid full loot reads with %i distant restored drops',
  (count) => {
    const store = new WorldStore(':memory:');
    const exploration = new ExplorationMap();
    exploration.reveal({ x: 40000, y: 24000 }, 260);
    const expiresAt = Date.now() + 3600000;
    store.checkpoint(
      { seed: 82, startedAt: 1, generation: WORLD.generation, exploration: exploration.snapshot() },
      new Map(),
      [],
      {
        settlement: emptySettlement(),
        pointLoot: [
          { id: 'newly-charted', position: { x: 6000, y: 0 }, points: 20, expiresAt },
          { id: 'near', position: { x: 400, y: 0 }, points: 10, expiresAt },
          { id: 'charted-far', position: { x: 40000, y: 24000 }, points: 20, expiresAt },
          ...Array.from({ length: count }, (_, i) => ({
            id: `hidden-${i}`,
            position: { x: 20000 + (i % 100) * 120, y: 20000 + Math.floor(i / 100) * 120 },
            points: 1,
            expiresAt,
          })),
        ],
      }
    );
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const full = vi.spyOn(LootManager.prototype, 'getAll').mockImplementation(() => {
      throw new Error('hot full loot read');
    });
    const nests = vi.spyOn(LootManager.prototype, 'getNestResources').mockImplementation(() => {
      throw new Error('hot full nest-resource read');
    });
    const socket = new RecordingSocket();
    try {
      const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 }, 'hauler');
      const broadcaster = new GameStateBroadcaster(engine);
      broadcaster.negotiateSnapshot(socket);
      engine.advanceOneFrame();
      broadcaster.broadcastGameState();
      const message = socket.sent.find((raw) => JSON.parse(raw).type === 'snapshot');
      assert(message);
      const decoded = decodeSnapshotMessage(new SnapshotDecoder(), message);
      expect(decoded.loot.filter((drop) => drop.kind === 'points').map((drop) => drop.id)).toEqual([
        'near',
      ]);
      for (const drop of decoded.loot) {
        expect(Math.abs(drop.position.x)).toBeLessThanOrEqual(WORLD.interestRadius);
        expect(Math.abs(drop.position.y)).toBeLessThanOrEqual(WORLD.interestRadius);
      }
      expect(decoded.mapAssets.some((asset) => asset.id === 'loot:charted-far')).toBe(true);
      expect(decoded.mapAssets.some((asset) => asset.id.startsWith('loot:hidden-'))).toBe(false);
      expect(decoded.mapAssets.some((asset) => asset.id === 'loot:newly-charted')).toBe(false);
      pilot.position = { x: 6200, y: 0 };
      engine.advanceOneFrame();
      expect(engine.getSnapshotState().mapAssets).toContainEqual({
        id: 'loot:newly-charted',
        kind: 'wreckage',
        position: { x: 6000, y: 0 },
        name: 'Salvage',
      });
      expect(
        engine.getSnapshotState().mapAssets.some((asset) => asset.id.startsWith('loot:hidden-'))
      ).toBe(false);
      expect(full).not.toHaveBeenCalled();
      expect(nests).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
      nests.mockRestore();
      engine.stopGameLoop();
      store.close();
    }
  }
);
