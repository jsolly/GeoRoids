import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { logger } from '../../../setup/serverLogger';
import { cargoCapacity, ECONOMY } from '../../../shared/economy';
import { GROWTH } from '../../../shared/shipGrowth';
import { instrumentLootIndex } from '../../support/lootIndexInstrumentation';
import { RecordingSocket } from '../../support/recordingSocket';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function pilot(engine: GameEngine, id = 'pilot') {
  const actor = engine.addPlayer(id, id, new RecordingSocket(), { x: 1000, y: 1000 }, 'scout');
  actor.spawnProtectionTimer = 0;
  return actor;
}

test('immunity and direct crew fire preserve cargo while fractional protection only shields its actual value', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  actor.cargo = 9;
  actor.spawnProtectionTimer = 20;
  expect(engine.shipDamage.apply(actor.id, 'spider', 50).applied).toBe(false);
  actor.spawnProtectionTimer = 0;
  actor.overlayHold = true;
  expect(engine.shipDamage.apply(actor.id, 'asteroid', 50).applied).toBe(false);
  actor.overlayHold = false;
  expect(engine.shipDamage.apply(actor.id, 'teammate', 50).applied).toBe(false);
  expect(actor.cargo).toBe(9);
  expect(engine.getLoot()).toEqual([]);
  const health = actor.health;
  engine.shipDamage.apply(actor.id, 'spider', 2);
  expect(actor.health).toBeCloseTo(health - 1.1);
  expect(actor.cargo).toBe(0);
  expect(engine.getLoot().reduce((sum, drop) => sum + (drop.points ?? 0), 0)).toBe(9);
});

test.each([
  {
    kit: 'scout',
    cargo: 500,
    damage: 0.01,
    points: [1],
    offset: 37,
    position: { x: 1000, y: 1200 },
    angle: Math.PI / 2,
    directions: [[0, 1]],
  },
  {
    kit: 'scout',
    cargo: 500,
    damage: 20.11,
    points: [68, 67, 67],
    offset: 37,
    position: { x: 1000, y: 1000 },
    angle: 0,
    directions: [
      [1, 0],
      [-0.5, Math.sqrt(3) / 2],
      [-0.5, -Math.sqrt(3) / 2],
    ],
  },
  {
    kit: 'hauler',
    cargo: 1500,
    damage: 100.1,
    points: [126, 125, 125, 125, 125, 125, 125, 125],
    offset: 52,
    position: { x: 1000, y: 1000 },
    angle: 0,
    directions: [
      [1, 0],
      [Math.SQRT1_2, Math.SQRT1_2],
      [0, 1],
      [-Math.SQRT1_2, Math.SQRT1_2],
      [-1, 0],
      [-Math.SQRT1_2, -Math.SQRT1_2],
      [0, -1],
      [Math.SQRT1_2, -Math.SQRT1_2],
    ],
  },
] as const)(
  '$kit cargo absorbs $damage damage and ejects every point in recoverable outward drops',
  ({ kit, cargo, damage, points, offset, position, angle, directions }) => {
    const engine = new GameEngine(42);
    engine.createAsteroids(0);
    const actor = engine.addPlayer('shielded', 'Shielded', new RecordingSocket(), position, kit);
    actor.spawnProtectionTimer = 0;
    actor.angle = angle;
    actor.cargo = cargo;
    actor.healthRegenTimer = 1;
    const health = actor.health;
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const outcome = engine.shipDamage.apply(actor.id, 'asteroid', damage);
    expect(outcome).toMatchObject({ applied: true, isDestroyed: false });
    expect(outcome.entity).toBe(actor);
    expect(actor.health).toBe(health);
    expect(actor.cargo).toBe(cargo - points.reduce((sum, value) => sum + value, 0));
    expect(actor.healthRegenTimer).toBe(300);
    expect(info.mock.calls.filter(([, event]) => event === 'damage_applied')).toEqual([]);
    const drops = engine.getLoot();
    expect(drops).toHaveLength(points.length);
    const identified = directions.map((direction, index) => {
      const drop = drops.find(
        (row) =>
          Math.abs(row.position.x - (position.x + direction[0] * offset)) < 0.000001 &&
          Math.abs(row.position.y - (position.y + direction[1] * offset)) < 0.000001
      );
      assert.ok(drop, 'Expected outward spill missing');
      expect(drop.kind).toBe('points');
      expect(drop.points).toBe(points[index]);
      return { drop, direction };
    });
    engine.advanceOneFrame();
    for (const { drop, direction } of identified) {
      const moved = engine.getLoot().find((row) => row.id === drop.id);
      assert.ok(moved, 'Identified ejected spill missing');
      expect(moved.points).toBe(drop.points);
      expect(moved.position.x).toBeCloseTo(drop.position.x + direction[0] * 9);
      expect(moved.position.y).toBeCloseTo(drop.position.y + direction[1] * 9);
    }
  }
);

test('a failed pilot capture leaves the real cargo spill visible and stops before hull damage', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  actor.cargo = 9;
  const health = actor.health;
  const failure = new Error('pilot capture failed');
  vi.spyOn(engine.pilotLedger, 'capture').mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => engine.shipDamage.apply(actor.id, 'spider', 2)).toThrow(failure);
  expect(actor.cargo).toBe(0);
  expect(engine.getLoot().map((drop) => drop.points)).toEqual([9]);
  expect(actor.healthRegenTimer).toBe(300);
  expect(actor.health).toBe(health);
  expect(actor.exploding).toBe(false);
});

test('full holds leave loot intact and two partial collectors conserve the original drop and deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const engine = new GameEngine(42);
  const first = pilot(engine, 'a');
  const second = pilot(engine, 'b');
  const loot = new LootManager(new RNGService(7), () => Date.now());
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
  const restored = new LootManager(new RNGService(7), () => Date.now());
  restored.restorePoints(loot.savedPoints());
  expect(restored.savedPoints()).toEqual(loot.savedPoints());
  vi.setSystemTime(original.expiresAt);
  restored.expire(60);
  expect(restored.getAll()).toEqual([]);
});

test('a partial shard or tap retains its identity and frame deadline instead of discarding points', () => {
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  const loot = new LootManager(new RNGService(7), () => Date.now());
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

test('distant shield spills settle without idle frame work and wake when a crew ship approaches', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const engine = new GameEngine(42);
  const actor = pilot(engine);
  const loot = new LootManager(new RNGService(7), () => Date.now());
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
  const restored = new LootManager(new RNGService(7), () => Date.now());
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
