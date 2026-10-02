import { afterEach, describe, expect, test, vi } from 'vitest';
import { instrumentLootIndex } from '../../../benchmarks/loot-index-instrumentation';

import { EntityManager, type GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { type LootCatalogObserver, LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { EQUIPMENT_DROPS } from '../../../shared/equipment';
import { cellWorldBounds, explorationCellAt } from '../../../shared/exploration';
import { GROWTH, lootOverlap } from '../../../shared/shipGrowth';
import { nearbyWorldRows, WORLD } from '../../../shared/world';
import type { SavedPointLoot, ShipKitId } from '../../../shared-types';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';
import { RecordingSocket } from '../../support/recordingSocket';

function collectorAt(position: { x: number; y: number }): GameEntity {
  return {
    exploding: false,
    health: 100,
    position,
  } as GameEntity;
}

describe('LootManager destroy-drop shards', () => {
  test('spawnShard drops a shard at the break site', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 40, y: -10 }, 12);

    expect(shard.kind).toBe('shard');
    expect(shard.position).toEqual({ x: 40, y: -10 });
    expect(shard.mass).toBe(GROWTH.SHARD_MASS);
    expect(shard.radius).toBe(GROWTH.LOOT_RADIUS);
    expect(manager.getCount()).toBe(1);
    expect(manager.get(shard.id)?.id).toBe(shard.id);
  });

  test('kill pellets stay wreckage and share the same field', () => {
    const manager = new LootManager(new RNGService(7));
    const engine = new GameEngine(7);
    try {
      const entity = engine.addPlayer('kill-pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
      const pellets = manager.spawnFromKill(entity, 1);
      expect(pellets.length).toBeGreaterThan(0);
      expect(pellets.every((drop) => drop.kind === 'wreckage')).toBe(true);

      manager.spawnShard({ x: 8, y: 8 }, 2);
      expect(manager.getAll().some((drop) => drop.kind === 'shard')).toBe(true);
      expect(manager.getAll().some((drop) => drop.kind === 'wreckage')).toBe(true);
    } finally {
      engine.stopGameLoop();
    }
  });

  test('remove is first-wins', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 0, y: 0 }, 0);
    expect(manager.remove(shard.id)?.id).toBe(shard.id);
    expect(manager.remove(shard.id)).toBeUndefined();
    expect(manager.getCount()).toBe(0);
  });

  test('nearby loot flies toward a living ship', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 64, y: 0 }, 20);
    manager.expire(1, [collectorAt({ x: 0, y: 0 })]);
    const after = manager.get(shard.id);
    expect(after?.position.x).toBeCloseTo(64 - GROWTH.LOOT_MAGNET_ACCEL);
    expect(after?.position.y).toBe(0);
  });

  test('loot magnet accumulates velocity across consecutive frames', () => {
    const manager = new LootManager(new RNGService(7));
    const shard = manager.spawnShard({ x: 80, y: 0 }, 20);
    manager.expire(20, [collectorAt({ x: 0, y: 0 })]);
    manager.expire(21, [collectorAt({ x: 0, y: 0 })]);
    const after = manager.get(shard.id);
    expect(after?.position.x).toBeCloseTo(80 - GROWTH.LOOT_MAGNET_ACCEL * (2 + GROWTH.LOOT_DRAG));
  });

  test('a Hauler collects a shard that a same-mass Scout still misses', () => {
    const manager = new LootManager(new RNGService(7));
    const engine = new GameEngine(7);
    try {
      const scout = engine.addPlayer(
        'scout',
        'Scout',
        new RecordingSocket(),
        { x: 0, y: 0 },
        'scout'
      );
      const hauler = engine.addPlayer(
        'barge',
        'Barge',
        new RecordingSocket(),
        { x: 0, y: 0 },
        'hauler'
      );
      const justPastScout = hullRadiusForKit('scout') + GROWTH.LOOT_RADIUS + 4;
      const shard = manager.spawnShard({ x: justPastScout, y: 0 }, 20);
      const collected = manager.collectOverlaps([scout, hauler]);
      expect(collected).toEqual([
        { collector: hauler, loot: expect.objectContaining({ id: shard.id }) },
      ]);
    } finally {
      engine.stopGameLoop();
    }
  });

  test('a mass-grown Scout still misses a shard just past the kit hull', () => {
    const manager = new LootManager(new RNGService(7));
    const engine = new GameEngine(7);
    try {
      const scout = engine.addPlayer(
        'scout',
        'Scout',
        new RecordingSocket(),
        { x: 0, y: 0 },
        'scout'
      );
      engine.updatePlayer('scout', { mass: GROWTH.SOFT_MAX_MASS });
      expect(scout.mass).toBe(GROWTH.SOFT_MAX_MASS);
      const justPastScout = hullRadiusForKit('scout') + GROWTH.LOOT_RADIUS + 4;
      const shard = manager.spawnShard({ x: justPastScout, y: 0 }, 20);
      expect(manager.collectOverlaps([scout])).toEqual([]);
      expect(manager.get(shard.id)?.id).toBe(shard.id);
    } finally {
      engine.stopGameLoop();
    }
  });
});

test.each(['tap', 'silk'] as const)(
  '%s visibly ejects before an overlapping ship can collect it',
  (kind) => {
    const manager = new LootManager(new RNGService(7));
    const drop =
      kind === 'tap'
        ? manager.spawnTap({ x: 0, y: 0 }, 0, { x: 3, y: 0 })
        : manager.spawnSilk({ x: 0, y: 0 }, 0, { x: 3, y: 0 });
    expect(drop.kind).toBe(kind);
    expect(drop.mass).toBe(kind === 'silk' ? 0 : GROWTH.TAP_LOOT_MASS);
    const collector = collectorAt({ x: 0, y: 0 });
    expect(manager.collectOverlaps([collector])).toEqual([]);
    for (let frame = 1; frame < GROWTH.TAP_LOOT_EJECT_FRAMES; frame++) {
      manager.expire(frame, [collector]);
      const moved = manager.get(drop.id);
      expect(moved?.position.x).toBeGreaterThan(collector.position.x);
      collector.position = { ...(moved?.position ?? collector.position) };
      expect(manager.collectOverlaps([collector])).toEqual([]);
    }
    manager.expire(GROWTH.TAP_LOOT_EJECT_FRAMES, [collector]);
    expect(manager.collectOverlaps([collector]).map((entry) => entry.loot.id)).toEqual([drop.id]);
  }
);

const instruments: ReturnType<typeof instrumentLootIndex>[] = [];

function observeLoot(manager: LootManager) {
  const instrumentation = instrumentLootIndex(manager);
  instruments.push(instrumentation);
  return instrumentation;
}

afterEach(() => {
  for (const instrumentation of instruments.splice(0)) {
    instrumentation.dispose();
  }
  vi.restoreAllMocks();
});

function pilot(id: string, position: { x: number; y: number }, kitId: ShipKitId = 'scout') {
  return new EntityManager(new RNGService(7)).addPlayer(
    id,
    id,
    new RecordingSocket(),
    position,
    kitId
  );
}

function savedPoint(id: string, x: number, y: number, expiresAt = 10000): SavedPointLoot {
  return { id, position: { x, y }, points: 2, expiresAt };
}

test('restoring distant points does not expand local collection, discovery or stationary motion work', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const manager = new LootManager(new RNGService(7));
  const instrumentation = observeLoot(manager);
  manager.restorePoints([savedPoint('near', 0, 0)]);
  const ship = pilot('pilot', { x: 0, y: 0 });
  const before = instrumentation.snapshot();
  expect(manager.queryNearby(ship.position).map((drop) => drop.id)).toEqual(['near']);
  expect(manager.getNestResourcesNear([ship.position], 4200).map((drop) => drop.id)).toEqual([
    'near',
  ]);
  manager.expire(1, [ship]);
  const baseline = instrumentation.snapshot();
  const localWork = {
    cells: baseline.cellVisits - before.cellVisits,
    buckets: baseline.bucketEntries - before.bucketEntries,
    motion: baseline.motionRows - before.motionRows,
    publicRows: baseline.publicRows - before.publicRows,
  };
  manager.restorePoints(
    Array.from({ length: 10000 }, (_, index) =>
      savedPoint(`far-${index}`, 30000 + (index % 100), 30000)
    )
  );
  const grownBefore = instrumentation.snapshot();
  expect(manager.queryNearby(ship.position).map((drop) => drop.id)).toEqual(['near']);
  expect(manager.getNestResourcesNear([ship.position], 4200).map((drop) => drop.id)).toEqual([
    'near',
  ]);
  manager.expire(2, [ship]);
  const grown = instrumentation.snapshot();
  expect({
    cells: grown.cellVisits - grownBefore.cellVisits,
    buckets: grown.bucketEntries - grownBefore.bucketEntries,
    motion: grown.motionRows - grownBefore.motionRows,
    publicRows: grown.publicRows - grownBefore.publicRows,
  }).toEqual(localWork);
  expect(grown.expiryPops - grownBefore.expiryPops).toBe(0);
  const collectionBefore = instrumentation.snapshot();
  expect(manager.collectOverlaps([ship]).map((entry) => entry.loot.id)).toEqual(['near']);
  expect(instrumentation.snapshot().bucketEntries - collectionBefore.bucketEntries).toBe(1);
  expect(manager.getCount()).toBe(10000);
});

test('point deadlines use one wall-clock boundary and direct collection removes due distant rows', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const manager = new LootManager(new RNGService(7));
  const instrumentation = observeLoot(manager);
  manager.restorePoints([savedPoint('due', 30000, 0, 1100), savedPoint('later', 30000, 0, 1101)]);
  const revision = manager.pointRevision;
  clock.mockClear();
  clock.mockReturnValueOnce(1100).mockReturnValue(1200);
  manager.expire(1);
  expect(clock).toHaveBeenCalledOnce();
  expect(manager.get('due')).toBeUndefined();
  expect(manager.get('later')).toBeDefined();
  expect(manager.pointRevision).toBe(revision + 1);
  expect(instrumentation.snapshot().wallDeadlines).toBe(1);
  clock.mockReturnValue(1090);
  manager.collectOverlaps([]);
  expect(manager.get('later')).toBeDefined();
  clock.mockReturnValue(1101);
  manager.collectOverlaps([]);
  expect(manager.get('later')).toBeUndefined();
  expect(manager.pointRevision).toBe(revision + 2);
  expect(instrumentation.snapshot().wallDeadlines).toBe(0);

  clock.mockReturnValue(1101);
  manager.restorePoints([
    savedPoint('already-due-overlap', 0, 0, 1102),
    savedPoint('admitted-overlap', 0, 0, 1103),
  ]);
  const a = pilot('a', { x: 0, y: 0 });
  const b = pilot('b', { x: 0, y: 0 });
  const beforeCollectionRevision = manager.pointRevision;
  clock.mockClear();
  clock.mockReturnValueOnce(1102).mockReturnValue(1200);
  const collected = manager.collectOverlaps([b, a]);
  expect(clock).toHaveBeenCalledOnce();
  expect(collected.map((entry) => ({ id: entry.loot.id, collector: entry.collector.id }))).toEqual([
    { id: 'admitted-overlap', collector: 'a' },
  ]);
  expect(a.cargo).toBe(2);
  expect(b.cargo).toBe(0);
  expect(manager.pointRevision).toBe(beforeCollectionRevision + 2);
  expect(manager.getCount()).toBe(0);
  expect(instrumentation.snapshot().wallDeadlines).toBe(0);
});

test('replacing and removing far-future point IDs leaves one deadline per live row across clock domains', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const manager = new LootManager(new RNGService(7));
  const instrumentation = observeLoot(manager);
  const shard = manager.spawnShard({ x: 0, y: 0 }, 0);
  manager.restorePoints([savedPoint(shard.id, 0, 0, 1e12)]);
  expect(instrumentation.snapshot()).toMatchObject({ frameDeadlines: 0, wallDeadlines: 1 });
  for (let index = 0; index < 100; index++) {
    manager.restorePoints([savedPoint(shard.id, index, 0, 1e12 + index)]);
  }
  expect(instrumentation.snapshot()).toMatchObject({ authoritativeRows: 1, wallDeadlines: 1 });
  manager.expire(GROWTH.LOOT_TTL_FRAMES);
  expect(manager.get(shard.id)?.kind).toBe('points');
  manager.remove(shard.id);
  expect(instrumentation.snapshot()).toMatchObject({
    authoritativeRows: 0,
    frameDeadlines: 0,
    wallDeadlines: 0,
  });
  manager.restorePoints(
    Array.from({ length: 32 }, (_, index) =>
      savedPoint(`queue-${index}`, index, 0, 2000 + (31 - index))
    )
  );
  for (const index of [3, 19, 31, 0]) {
    manager.remove(`queue-${index}`);
  }
  // Move an interior deadline ahead of the root, and move a near-root deadline past all others.
  manager.restorePoints([savedPoint('queue-8', 8, 0, 1995), savedPoint('queue-30', 30, 0, 2040)]);
  const scheduled = Array.from({ length: 32 }, (_, index) => ({
    id: `queue-${index}`,
    deadline: index === 8 ? 1995 : index === 30 ? 2040 : 2000 + (31 - index),
  })).filter((drop) => !['queue-3', 'queue-19', 'queue-31', 'queue-0'].includes(drop.id));
  const beforeDue = instrumentation.snapshot();
  expect(beforeDue.wallDeadlines).toBe(scheduled.length);
  for (const boundary of [1994, 1995, 2005, 2015, 2031, 2040]) {
    clock.mockReturnValue(boundary);
    manager.expire(0);
    const survivors = scheduled.filter((drop) => drop.deadline > boundary);
    expect(manager.getAll().map((drop) => drop.id)).toEqual(
      survivors.map((drop) => drop.id).sort((a, b) => a.localeCompare(b))
    );
    expect(instrumentation.snapshot()).toMatchObject({
      authoritativeRows: survivors.length,
      wallDeadlines: survivors.length,
    });
    expect(instrumentation.snapshot().expiryPops - beforeDue.expiryPops).toBe(
      scheduled.length - survivors.length
    );
  }
  expect(manager.getCount()).toBe(0);
  expect(instrumentation.snapshot().wallDeadlines).toBe(0);
  manager.spawnShard({ x: 0, y: 0 }, 10);
  manager.restorePoints([savedPoint('clear', 0, 0, 1e12)]);
  manager.clear();
  expect(instrumentation.snapshot()).toMatchObject({
    authoritativeRows: 0,
    occupiedCells: 0,
    frameDeadlines: 0,
    wallDeadlines: 0,
  });
});

test('guarded cache lifetime replaces ordinary deadlines and its rewards cannot seed another nest', () => {
  const manager = new LootManager(new RNGService(7));
  const instrumentation = observeLoot(manager);
  manager.spawnNestCache({ x: 0, y: 0 }, 0);
  const count = manager.getCount();
  expect(count).toBeGreaterThan(0);
  expect(instrumentation.snapshot().frameDeadlines).toBe(count);
  expect(manager.getNestResourcesNear([{ x: 0, y: 0 }], 4200)).toEqual([]);
  manager.expire(GROWTH.LOOT_TTL_FRAMES);
  expect(manager.getCount()).toBe(count);
  manager.expire(EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES - 1);
  expect(manager.getCount()).toBe(count);
  manager.expire(EQUIPMENT_DROPS.NEST_LIFETIME_FRAMES);
  expect(manager.getCount()).toBe(0);
  expect(instrumentation.snapshot().frameDeadlines).toBe(0);
});

test('distant ejections and exact tiny velocities keep moving through cell seams without duplicate memberships', () => {
  const manager = new LootManager(new RNGService(7));
  const instrumentation = observeLoot(manager);
  const tap = manager.spawnTap({ x: 255, y: 30000 }, 0, { x: 3, y: 0 });
  const tiny = manager.spawnSilk({ x: 0, y: 30000 }, 0, { x: Number.MIN_VALUE, y: 0 });
  manager.expire(1);
  expect(
    manager.queryBounds({ minX: 256, maxX: 260, minY: 30000, maxY: 30000 }).map((drop) => drop.id)
  ).toEqual([tap.id]);
  expect(
    manager.queryBounds({ minX: 0, maxX: 255, minY: 30000, maxY: 30000 }).map((drop) => drop.id)
  ).toEqual([tiny.id]);
  expect(manager.get(tiny.id)?.position.x).toBe(Number.MIN_VALUE);
  for (let frame = 2; frame <= GROWTH.TAP_LOOT_EJECT_FRAMES; frame++) {
    manager.expire(frame);
  }
  expect(instrumentation.snapshot()).toMatchObject({ movingRows: 2, ejectingRows: 0 });
  expect(instrumentation.snapshot().motionRows).toBe(2 * GROWTH.TAP_LOOT_EJECT_FRAMES);
  manager.expire(GROWTH.TAP_LOOT_EJECT_FRAMES + 1);
  expect(instrumentation.snapshot().motionRows).toBe(2 * (GROWTH.TAP_LOOT_EJECT_FRAMES + 1));
});

test('indexed candidates retain original rounded magnet, nest, hull, snapshot and exploration predicates', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const manager = new LootManager(new RNGService(7));
  manager.restorePoints([
    savedPoint('cancellation', 1e-13, 0),
    savedPoint('hypot', 4199.999867352518, 1.0555751204935209),
    savedPoint('outside', 4200.001, 0),
    savedPoint('cell-cancellation', -1e-13, 1),
  ]);
  const all = manager.getAll();
  const insertionOrder = manager
    .savedPoints()
    .map((drop) => manager.get(drop.id))
    .filter((drop) => drop !== undefined);
  for (const position of [
    { x: 0, y: 0 },
    { x: -4200, y: 0 },
  ]) {
    expect(manager.getNestResourcesNear([position], 4200)).toEqual(
      insertionOrder.filter(
        (drop) => Math.hypot(position.x - drop.position.x, position.y - drop.position.y) <= 4200
      )
    );
  }
  const center = { x: -WORLD.interestRadius, y: 0 };
  expect(manager.queryNearby(center)).toEqual(nearbyWorldRows(all, center));
  const cell = explorationCellAt({ x: 0, y: 1 });
  expect(cell).not.toBeNull();
  if (cell === null) {
    throw new Error('Missing finite-world cell');
  }
  expect(cellWorldBounds(cell).x).toBe(0);
  expect(manager.queryExplorationCell(cell)).toEqual(
    all.filter((drop) => explorationCellAt(drop.position) === cell)
  );
  expect(
    manager
      .queryBounds({ minX: 0, maxX: 125, minY: 0, maxY: 125 })
      .some((drop) => drop.id === 'cell-cancellation')
  ).toBe(false);
  const tap = manager.spawnTap({ x: 1e-14, y: 30000 }, 0, { x: 0, y: 0 });
  const hauler = pilot('hauler', { x: -160, y: 30000 }, 'hauler');
  for (let frame = 1; frame <= GROWTH.TAP_LOOT_EJECT_FRAMES; frame++) {
    manager.expire(frame);
  }
  manager.expire(GROWTH.TAP_LOOT_EJECT_FRAMES + 1, [hauler]);
  expect(manager.get(tap.id)?.position.x).toBeLessThan(0);
  const hullPilot = pilot('hull', {
    x: -(hullRadiusForKit('scout') + GROWTH.LOOT_RADIUS + 2),
    y: 0,
  });
  const expected = manager
    .queryNearby(hullPilot.position)
    .filter((drop) =>
      lootOverlap(hullPilot.position, hullRadiusForKit(hullPilot.kitId), drop.position, drop.radius)
    );
  expect(manager.collectOverlaps([hullPilot]).map((entry) => entry.loot.id)).toEqual(
    expected.map((drop) => drop.id)
  );
});

test('locale-equal loot IDs retain insertion order while locale-equal collectors retain supplied order', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const manager = new LootManager(new RNGService(7));
  const firstId = 'é';
  const secondId = 'e\u0301';
  expect(firstId.localeCompare(secondId)).toBe(0);
  manager.restorePoints([savedPoint(firstId, 1, 0), savedPoint(secondId, -1, 0)]);
  manager.restorePoints([savedPoint(firstId, 1, 0, 11000)]);
  expect(manager.queryNearby({ x: 0, y: 0 }).map((drop) => drop.id)).toEqual([firstId, secondId]);
  const firstCollector = pilot(secondId, { x: 0, y: 0 });
  const secondCollector = pilot(firstId, { x: 0, y: 0 });
  const results = manager.collectOverlaps([firstCollector, secondCollector]);
  expect(results.map((entry) => entry.loot.id)).toEqual([firstId, secondId]);
  expect(results.map((entry) => entry.collector)).toEqual([firstCollector, firstCollector]);
  expect(firstCollector.cargo).toBe(4);
  expect(secondCollector.cargo).toBe(0);
});

test('equipment stays available per eligible pilot and catalog hooks preserve authoritative ordinal through replacement', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const observer = {
    changed: vi.fn<LootCatalogObserver['changed']>(),
    moved: vi.fn<LootCatalogObserver['moved']>(),
    removed: vi.fn<LootCatalogObserver['removed']>(),
    cleared: vi.fn<LootCatalogObserver['cleared']>(),
  } satisfies LootCatalogObserver;
  const manager = new LootManager(new RNGService(7), observer);
  const instrumentation = observeLoot(manager);
  const equipment = manager.spawnEquipment({ x: 0, y: 0 }, 0, 'resource_tap');
  const a = pilot('a', { x: 0, y: 0 }, 'hauler');
  const b = pilot('b', { x: 0, y: 0 }, 'hauler');
  expect(manager.collectOverlaps([b, a]).map((entry) => entry.collector.id)).toEqual(['a']);
  a.equipment = ['resource_tap'];
  expect(manager.collectOverlaps([b, a]).map((entry) => entry.collector.id)).toEqual(['b']);
  expect(manager.get(equipment.id)).toBeDefined();
  const ordinal = observer.changed.mock.calls[0]?.[1];
  manager.restorePoints([savedPoint(equipment.id, 0, 0)]);
  expect(observer.changed.mock.calls.at(-1)?.[1]).toBe(ordinal);
  expect(instrumentation.snapshot()).toMatchObject({ frameDeadlines: 0, wallDeadlines: 1 });
  manager.remove(equipment.id);
  manager.restorePoints([savedPoint(equipment.id, 0, 0)]);
  expect(observer.changed.mock.calls.at(-1)?.[1]).not.toBe(ordinal);
  expect(observer.removed).toHaveBeenCalledWith(equipment.id);
  manager.clear();
  expect(observer.cleared).toHaveBeenCalledOnce();
});

test('disposable eviction keeps insertion priority without counting restored points or equipment against its cap', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const manager = new LootManager(new RNGService(7));
  const instrumentation = observeLoot(manager);
  manager.restorePoints(
    Array.from({ length: 1000 }, (_, index) => savedPoint(`saved-${index}`, 30000, 30000))
  );
  const equipment = manager.spawnEquipment({ x: 0, y: 0 }, 0, 'resource_tap');
  const first = manager.spawnShard({ x: 0, y: 0 }, 0);
  const second = manager.spawnShard({ x: 0, y: 0 }, 0);
  for (let index = 2; index <= GROWTH.MAX_LOOT; index++) {
    manager.spawnShard({ x: 0, y: 0 }, 0);
  }
  expect(manager.get(first.id)).toBeUndefined();
  expect(manager.get(second.id)).toBeDefined();
  expect(manager.get(equipment.id)).toBeDefined();
  expect(instrumentation.snapshot()).toMatchObject({
    disposableRows: GROWTH.MAX_LOOT,
    pointRows: 1000,
    frameDeadlines: GROWTH.MAX_LOOT + 1,
    wallDeadlines: 1000,
  });
});
