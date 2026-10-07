/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { instrumentLootIndex } from '../../../benchmarks/loot-index-instrumentation';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { calculateHealthRegenDelayFrames } from '../../../shared/constants/health';
import { cargoCapacity, ECONOMY } from '../../../shared/economy';
import { GROWTH } from '../../../shared/shipGrowth';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

afterEach(() => vi.useRealTimers());
function pilot(engine: GameEngine, id = 'pilot') {
  const actor = engine.addPlayer(id, id, new RecordingSocket(), { x: 1000, y: 1000 }, 'scout');
  actor.spawnProtectionTimer = 0;
  actor.asteroidInteractions = 1;
  return actor;
}

test('cargo absorbs a hazard, then a lethal residual hit spills every point exactly once', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  actor.cargo = 450;
  actor.healthRegenTimer = 0;
  const initialHealth = actor.health;
  const first = engine.handleShipDamage(actor.id, 'asteroid', 20);
  expect(first).toMatchObject({ applied: true, isDestroyed: false });
  expect(actor.health).toBe(initialHealth);
  expect(actor.cargo).toBe(250);
  expect(actor.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());
  expect(engine.getLoot().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(200);
  engine.collectLoot();
  expect(actor.cargo).toBe(250);
  expect(engine.handleShipDamage(actor.id, 'ricochet', initialHealth + 25).isDestroyed).toBe(true);
  expect(actor.cargo).toBe(0);
  expect(actor.health).toBe(0);
  expect(engine.getLoot().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(450);
  engine.handleShipDamage(actor.id, 'asteroid', 500);
  expect(engine.getLoot().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(450);
});

test('immunity and direct crew fire preserve cargo while fractional protection only shields its actual value', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  actor.cargo = 9;
  actor.spawnProtectionTimer = 20;
  expect(engine.handleShipDamage(actor.id, 'spider', 50).applied).toBe(false);
  actor.spawnProtectionTimer = 0;
  actor.overlayHold = true;
  expect(engine.handleShipDamage(actor.id, 'asteroid', 50).applied).toBe(false);
  actor.overlayHold = false;
  expect(engine.handleShipDamage(actor.id, 'teammate', 50).applied).toBe(false);
  expect(actor.cargo).toBe(9);
  expect(engine.getLoot()).toEqual([]);
  const health = actor.health;
  engine.handleShipDamage(actor.id, 'spider', 2);
  expect(actor.health).toBeCloseTo(health - 1.1);
  expect(actor.cargo).toBe(0);
  expect(engine.getLoot().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(9);
});

test('full holds leave loot intact and two partial collectors conserve the original drop and deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const engine = new GameEngine(42);
  const first = pilot(engine, 'a');
  const second = pilot(engine, 'b');
  const loot = new LootManager(new RNGService(7));
  loot.spawnPoints(first.position, 80);
  const original = loot.savedPoints()[0];
  if (!original) {
    throw new Error('Point fixture missing');
  }
  first.cargo = cargoCapacity(first.kitId);
  expect(loot.collectOverlaps([first])).toEqual([]);
  expect(loot.savedPoints()[0]).toEqual(original);
  first.cargo -= 10;
  second.cargo = cargoCapacity(second.kitId) - 20;
  loot.collectOverlaps([second, first]);
  expect(first.cargo).toBe(cargoCapacity(first.kitId));
  expect(loot.savedPoints()[0]).toMatchObject({
    id: original.id,
    expiresAt: original.expiresAt,
    points: 70,
  });
  loot.collectOverlaps([second, first]);
  expect(second.cargo).toBe(cargoCapacity(second.kitId));
  expect(loot.savedPoints()[0]).toMatchObject({
    id: original.id,
    expiresAt: original.expiresAt,
    points: 50,
  });
  const restored = new LootManager(new RNGService(7));
  restored.restorePoints(loot.savedPoints());
  expect(restored.savedPoints()).toEqual(loot.savedPoints());
  vi.setSystemTime(original.expiresAt);
  restored.expire(60);
  expect(restored.getAll()).toEqual([]);
});

test('a partial shard or tap retains its identity and frame deadline instead of discarding points', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  const loot = new LootManager(new RNGService(7));
  for (const kind of ['shard', 'tap'] as const) {
    actor.cargo = cargoCapacity(actor.kitId) - 1;
    const drop =
      kind === 'shard'
        ? loot.spawnShard(actor.position, 0)
        : loot.spawnTap(actor.position, 0, { x: 0, y: 0 });
    for (let frame = 0; frame <= GROWTH.TAP_LOOT_EJECT_FRAMES; frame++) {
      loot.expire(frame);
    }
    const before = loot.get(drop.id)?.points ?? 0;
    loot.collectOverlaps([actor]);
    expect(actor.cargo).toBe(cargoCapacity(actor.kitId));
    expect(loot.get(drop.id)?.points).toBe(before - 1);
    loot.expire(GROWTH.LOOT_TTL_FRAMES);
    expect(loot.get(drop.id)).toBeUndefined();
  }
});

test('ejected points travel beyond pickup and magnet range before the spill becomes recoverable', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  const loot = new LootManager(new RNGService(7));
  loot.spawnPoints(actor.position, 200, {
    velocity: { x: ECONOMY.cargoSpillSpeed, y: 0 },
    ejectFramesLeft: ECONOMY.cargoSpillEjectFrames,
  });
  const drop = loot.getAll()[0];
  if (!drop) {
    throw new Error('Spill missing');
  }
  expect(loot.collectOverlaps([actor])).toEqual([]);
  for (let frame = 0; frame < ECONOMY.cargoSpillEjectFrames; frame++) {
    loot.expire(frame, [actor]);
    expect(loot.collectOverlaps([actor])).toEqual([]);
  }
  const escaped = loot.get(drop.id);
  if (!escaped) {
    throw new Error('Spill disappeared');
  }
  expect(escaped.position.x - actor.position.x).toBeGreaterThan(GROWTH.LOOT_MAGNET_RANGE);
  actor.position = { ...escaped.position };
  expect(loot.collectOverlaps([actor])).toHaveLength(1);
  expect(actor.cargo).toBe(200);
});

test('restart preserves partial bank transfers and moving recoverable shield spills in one checkpoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-cargo-'));
  const path = join(directory, 'world.sqlite');
  let store = new WorldStore(path);
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    const actor = pilot(engine);
    actor.position = { x: 0, y: 0 };
    const registered = engine.registerPilot(actor, actor.ws ?? new RecordingSocket());
    if (!registered.ok) {
      throw new Error(registered.error);
    }
    actor.spawnProtectionTimer = 0;
    actor.cargo = 400;
    for (let frame = 0; frame < 12; frame++) {
      engine.depositCargo();
    }
    actor.position = { x: 1000, y: 1000 };
    engine.handleShipDamage(actor.id, 'asteroid', 10);
    engine.checkpointWorld();
    const saved = store.load().economy?.pointLoot;
    store.close();
    store = new WorldStore(path);
    expect(store.load().economy?.pointLoot).toEqual(saved);
    const restarted = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    const resumed = restarted.resumePilot(registered.resumeToken, new RecordingSocket());
    if (!resumed.ok) {
      throw new Error('Resume failed');
    }
    expect(resumed.actor.score).toBe(25);
    expect(resumed.actor.cargo).toBe(275);
    expect(restarted.getLoot().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(100);
    expect(restarted.getGameState().settlement.points).toBe(25);
    restarted.collectLoot();
    expect(resumed.actor.cargo).toBe(275);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a hazard near the world edge keeps every spilled point inside collectible space', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-edge-cargo-'));
  const store = new WorldStore(join(directory, 'world.sqlite'));
  try {
    const engine = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    const actor = pilot(engine);
    actor.position = { x: WORLD.radius - 30, y: 0 };
    actor.cargo = 500;
    engine.handleShipDamage(actor.id, 'boundary', 100);
    engine.checkpointWorld();
    const loot = new LootManager(new RNGService(7));
    loot.restorePoints(store.load().economy?.pointLoot ?? []);
    expect(
      loot
        .savedPoints()
        .some((drop) => Math.hypot(drop.velocity?.x ?? 0, drop.velocity?.y ?? 0) > 0)
    ).toBe(true);
    for (let frame = 0; frame < 120; frame++) {
      loot.expire(frame);
    }
    expect(loot.getAll().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(500);
    for (const drop of loot.getAll()) {
      const radius = Math.hypot(drop.position.x, drop.position.y);
      expect(radius).toBeLessThanOrEqual(WORLD.radius - drop.radius);
      if (!loot.get(drop.id)) {
        continue;
      }
      const reach = Math.min(radius, WORLD.radius - 30);
      actor.position = {
        x: (drop.position.x / radius) * reach,
        y: (drop.position.y / radius) * reach,
      };
      expect(loot.collectOverlaps([actor]).length).toBeGreaterThan(0);
    }
    expect(actor.cargo).toBe(500);
    expect(loot.getAll()).toEqual([]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('distant shield spills settle without idle frame work and wake when a crew ship approaches', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  const loot = new LootManager(new RNGService(7));
  loot.spawnPoints({ x: 1000, y: 1000 }, 250, {
    velocity: { x: 9, y: 0 },
    ejectFramesLeft: ECONOMY.cargoSpillEjectFrames,
  });
  const original = loot.savedPoints()[0];
  expect(original).toBeDefined();
  const work = instrumentLootIndex(loot);
  for (let frame = 0; frame < 120; frame++) {
    loot.expire(frame);
  }
  const settled = loot.savedPoints()[0];
  expect(settled).toMatchObject({
    id: original?.id,
    points: 250,
    expiresAt: original?.expiresAt,
    velocity: { x: 0, y: 0 },
    ejectFramesLeft: 0,
  });
  expect(work.snapshot().movingRows).toBe(0);
  const motion = work.snapshot().motionRows;
  const revision = loot.pointRevision;
  for (let frame = 120; frame < 240; frame++) {
    loot.expire(frame);
  }
  expect(work.snapshot().motionRows).toBe(motion);
  expect(loot.pointRevision).toBe(revision);
  const restored = new LootManager(new RNGService(7));
  restored.restorePoints(loot.savedPoints());
  restored.expire(240);
  expect(restored.savedPoints()[0]).toEqual(settled);
  if (!settled) {
    throw new Error('Settled spill missing');
  }
  actor.position = { x: settled.position.x - 60, y: settled.position.y };
  loot.expire(241, [actor]);
  expect(work.snapshot().movingRows).toBe(1);
  expect(loot.pointRevision).toBeGreaterThan(revision);
  const awakened = loot.savedPoints()[0];
  expect(awakened).toMatchObject({ id: original?.id, points: 250, expiresAt: original?.expiresAt });
  expect(awakened?.position.x).toBeLessThan(settled.position.x);
  work.dispose();
});
