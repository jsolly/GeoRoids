/* @vitest-environment node */
import { expect, test } from 'vitest';
import { EntityManager } from '../../../server/core/EntityManager';
import { RNGService } from '../../../server/core/RNGService';
import { RolyPolyManager } from '../../../server/core/RolyPolyManager';
import { ROLY_POLY } from '../../../shared/rolyPoly';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { WORLD } from '../../../shared/world';
import { GameServerWorld } from '../scenarios/support/gameServerWorld';

test.each(['scout', 'hauler'] as const)(
  '%s: a neutral animal curls at an approaching pilot, rolls when nudged, then resumes walking without damaging the pilot',
  (kit) => {
    const actors = new EntityManager(new RNGService(23), () => 0);
    const manager = new RolyPolyManager(actors);
    const pilot = actors.addPlayer('visitor', 'Visitor', undefined, { x: 0, y: 0 }, kit);
    pilot.spawnProtectionTimer = 0;
    const health = pilot.health;
    pilot.velocity = { x: 1, y: 0 };
    manager.advance(1);
    const animal = manager.snapshot()[0];
    if (!animal) {
      throw new Error('Expected occupied habitat');
    }
    const id = animal.id;
    pilot.position = { x: animal.position.x + 80, y: animal.position.y };
    manager.advance(2);
    expect(manager.snapshot().find((row) => row.id === id)).toMatchObject({
      phase: 'curled',
      velocity: { x: 0, y: 0 },
    });
    pilot.position = { x: animal.position.x + 40, y: animal.position.y };
    manager.advance(3);
    expect(manager.snapshot().find((row) => row.id === id)?.phase).toBe(
      kit === 'scout' ? 'curled' : 'rolling'
    );
    pilot.position = { ...animal.position };
    manager.advance(4);
    const rolling = manager.snapshot().find((row) => row.id === id);
    expect(rolling?.phase).toBe('rolling');
    expect(Math.hypot(rolling?.velocity.x ?? 0, rolling?.velocity.y ?? 0)).toBeCloseTo(
      ROLY_POLY.rollSpeed
    );
    expect(pilot.health).toBe(health);
    if (!rolling) {
      throw new Error('Expected the identified animal to be rolling');
    }
    expect(
      rolling.velocity.x * pilot.velocity.x + rolling.velocity.y * pilot.velocity.y
    ).toBeGreaterThan(0);
    const velocity = { ...rolling.velocity };
    rolling.velocity.x = Infinity;
    expect(manager.snapshot().find((row) => row.id === id)?.velocity).toEqual(velocity);
    pilot.position = { x: animal.position.x + 400, y: animal.position.y };
    manager.advance(4 + ROLY_POLY.rollFrames);
    expect(manager.snapshot().find((row) => row.id === id)?.phase).toBe('walking');
    animal.position.x = Infinity;
    expect(manager.snapshot().every((row) => Number.isFinite(row.position.x))).toBe(true);
  }
);

test('only visited habitats exist, with a fixed total budget and no population after the last pilot leaves', () => {
  const actors = new EntityManager(new RNGService(23), () => 0);
  const manager = new RolyPolyManager(actors);
  for (let i = 0; i < 100; i++) {
    actors.addPlayer(`visitor-${i}`, 'Visitor', undefined, { x: i * 800, y: i * 600 });
  }
  manager.advance(1);
  expect(manager.snapshot().length).toBeGreaterThan(0);
  expect(manager.snapshot().length).toBeLessThanOrEqual(ROLY_POLY.maximumActive);
  expect(
    manager.snapshot().every((row) => Math.hypot(row.position.x, row.position.y) < WORLD.radius)
  ).toBe(true);
  actors.clearAll();
  manager.advance(60);
  expect(manager.snapshot()).toEqual([]);
});

test.each(['worker', 'dead', 'exploding'] as const)(
  '%s: wildlife habitats follow the original living actor admission',
  (kind) => {
    const actors = new EntityManager(new RNGService(23), () => 0);
    const manager = new RolyPolyManager(actors);
    const pilot =
      kind === 'worker'
        ? actors.addBot('visitor', 'worker', { x: 0, y: 0 })
        : actors.addPlayer('visitor', 'Visitor', undefined, { x: 0, y: 0 });
    if (kind === 'dead') {
      pilot.health = 0;
    }
    pilot.exploding = kind === 'exploding';
    manager.advance(1);
    if (kind === 'worker') {
      expect(manager.snapshot().length).toBeGreaterThan(0);
    } else {
      expect(manager.snapshot()).toEqual([]);
    }
  }
);

test('the real server sends nearby wildlife through snapshot validation and excludes remote habitats', () => {
  const world = new GameServerWorld();
  try {
    const near = world.join('Near', { x: 0, y: 0 });
    const far = world.join('Far', { x: 0, y: 0 });
    world.entity(far).position = { x: 20000, y: 20000 };
    world.engine.advanceCombatFrame();
    world.broadcastGameState();
    expect(world.snapshot(near).rolyPolys).toEqual([]);
    world.engine.advanceOneFrame();
    world.broadcastGameState();
    const snapshot = world.snapshot(near);
    validateSnapshotDto(snapshot);
    expect(snapshot.rolyPolys?.length).toBeGreaterThan(0);
    const ids = new Set(snapshot.rolyPolys?.map((row) => row.id));
    expect(world.snapshot(far).rolyPolys?.some((row) => ids.has(row.id))).toBe(false);
    expect(() =>
      validateSnapshotDto({
        ...snapshot,
        rolyPolys: [{ ...snapshot.rolyPolys?.[0], phase: 'attacking' }],
      })
    ).toThrow();
  } finally {
    world.dispose();
  }
});
