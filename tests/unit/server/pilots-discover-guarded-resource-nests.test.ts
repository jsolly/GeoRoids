import { expect, test } from 'vitest';
import type { SpiderResource } from '../../../server/core/spiderResources';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { SPIDER } from '../../../shared/terrainSpider';
import type { Position } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';

const home = { x: 5000, y: 5000 };
function setup(value: SpiderResource['value'] = 1) {
  const manager = new TerrainSpiderManager(() => 0.5);
  const pilot = { id: 'pilot', position: { x: 3000, y: 5000 }, health: 100, exploding: false };
  const resource: SpiderResource = { id: 'ore', position: home, value };
  const resources = () => [resource];
  let frame = 0;
  const step = (frames = 1, completedSectors: ReadonlySet<string> = new Set()) => {
    for (let i = 0; i < frames; i++) {
      manager.advance({ players: [pilot], resources, completedSectors, nowFrame: ++frame });
    }
  };
  return { manager, pilot, resource, step };
}
function distance(a: Position, b: Position) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test.each([0, 1, 2] as const)(
  'resource value %i creates the matching guard group before the pilot reaches it',
  (value) => {
    const { manager, step } = setup(value);
    step();
    expect(manager.snapshot().spiders).toHaveLength(SPIDER.NEST_GUARDS[value]);
    step(600);
    for (const spider of manager.snapshot().spiders) {
      expect(distance(spider.position, home)).toBeLessThanOrEqual(
        SPIDER.NEST_PATROL_RADIUS + SPIDER.SCUTTLE_SPEED
      );
      expect(spider.targetId).toBeNull();
    }
  }
);

test('guards briefly chase intruders and return to their own resource even if prey stays nearby', () => {
  const { manager, pilot, step } = setup();
  step();
  const first = manager.snapshot().spiders[0];
  if (!first) {
    throw new Error('Expected guards');
  }
  pilot.position = { x: home.x + 600, y: home.y };
  // Enter the actual patrol area to start a hunt, then draw the guard out.
  pilot.position = { ...first.position };
  step();
  expect(manager.snapshot().spiders.find((spider) => spider.id === first.id)?.phase).toBe(
    'hunting'
  );
  pilot.position = { x: home.x + 700, y: home.y };
  step(SPIDER.NEST_CHASE_FRAMES + 1);
  expect(manager.snapshot().spiders.find((spider) => spider.id === first.id)?.targetId).toBeNull();
  step(1200);
  const returned = manager.snapshot().spiders.find((spider) => spider.id === first.id);
  expect(returned).toBeDefined();
  expect(distance(returned?.position ?? { x: 0, y: 0 }, home)).toBeLessThan(
    SPIDER.NEST_PATROL_RADIUS + SPIDER.SCUTTLE_SPEED
  );
});

test('a pilot outside the home leash cannot drag the guards across the map', () => {
  const { manager, pilot, step } = setup();
  step();
  pilot.position = { ...home };
  step();
  expect(manager.snapshot().spiders.some((spider) => spider.phase === 'hunting')).toBe(true);
  pilot.position = { x: home.x + SPIDER.NEST_LEASH_DISTANCE + 1, y: home.y };
  step(2);
  expect(manager.snapshot().spiders.every((spider) => spider.targetId === null)).toBe(true);
});

test('leaving and revisiting preserves wounded guards and never replaces killed guards', () => {
  const { manager, pilot, step } = setup();
  step();
  const [wounded, killed] = manager.snapshot().spiders;
  if (!wounded || !killed) {
    throw new Error('Expected guards');
  }
  manager.resolveLaserHit(wounded.position, wounded.position, DAMAGE.LASER_HIT);
  manager.resolveLaserHit(killed.position, killed.position, SPIDER.MAX_HEALTH);
  const expected = manager
    .snapshot()
    .spiders.map((spider) => ({ id: spider.id, health: spider.health }));
  pilot.position = { x: -10000, y: -10000 };
  step(60);
  expect(manager.snapshot().spiders).toEqual([]);
  pilot.position = { x: 3000, y: 5000 };
  step(60);
  expect(
    manager.snapshot().spiders.map((spider) => ({ id: spider.id, health: spider.health }))
  ).toEqual(expected);
  for (const spider of manager.snapshot().spiders) {
    manager.removeSpider(spider.id);
  }
  step(120);
  expect(manager.snapshot().spiders).toEqual([]);
});

test('nests never materialize beside a pilot or inside completed sectors', () => {
  const nearby = setup();
  nearby.pilot.position = { ...home };
  nearby.step(60);
  expect(nearby.manager.snapshot().spiders).toEqual([]);
  const protectedSite = setup();
  protectedSite.step(60, new Set(['2,2']));
  expect(protectedSite.manager.snapshot().spiders).toEqual([]);
});

test('valuable resources away from a widely spaced nest site remain unguarded', () => {
  const { manager, resource, pilot, step } = setup(2);
  resource.position = { x: 2200, y: 2200 };
  pilot.position = { x: 4000, y: 2200 };
  step(120);
  expect(manager.snapshot().spiders).toEqual([]);
});

test('a completed sector removes sleeping guards when that territory is revisited', () => {
  const { manager, pilot, step } = setup();
  step();
  pilot.position = { x: -10000, y: -10000 };
  step(60);
  pilot.position = { x: 3000, y: 5000 };
  step(60, new Set(['2,2']));
  expect(manager.snapshot().spiders).toEqual([]);
});

test('an empty server preserves cleared nests and pauses the roaming clock', () => {
  const { manager, step } = setup();
  step();
  for (const spider of manager.snapshot().spiders) {
    manager.removeSpider(spider.id);
  }
  manager.suspend();
  step(120);
  expect(manager.snapshot().spiders).toEqual([]);
});

test('dormant guards cannot reappear directly on any returning pilot', () => {
  const { manager, pilot, step } = setup();
  step();
  manager.suspend();
  pilot.position = { ...home };
  step(120);
  expect(manager.snapshot().spiders).toEqual([]);
  pilot.position = { x: 3000, y: 5000 };
  step(60);
  expect(manager.snapshot().spiders).toHaveLength(4);
});

test('shooting guards from outside detection range postpones a due roaming attack', () => {
  const { manager, step } = setup();
  step(14_399);
  const guards = manager.snapshot().spiders;
  expect(guards).toHaveLength(4);
  for (const spider of guards) {
    manager.resolveLaserHit(spider.position, spider.position, SPIDER.MAX_HEALTH);
  }
  step(3);
  expect(manager.snapshot().spiders).toEqual([]);
});

test.each(['awake', 'sleeping'] as const)(
  'completing a nest retires its %s guards even when they are outside the home sector',
  (state) => {
    const { manager, resource, pilot, step } = setup(0);
    resource.position = { x: 5700, y: 5000 };
    pilot.position = { x: 3700, y: 5000 };
    step();
    const guard = manager.snapshot().spiders[0];
    if (!guard) {
      throw new Error('Expected a nest guard');
    }
    pilot.position = { ...guard.position };
    step();
    pilot.position = { x: 6400, y: 5000 };
    step(300);
    expect(
      manager.snapshot().spiders.find(({ id }) => id === guard.id)?.position.x
    ).toBeGreaterThan(6000);
    if (state === 'sleeping') {
      manager.suspend();
      pilot.position = { x: 3700, y: 5000 };
    }
    step(60, new Set(['2,2']));
    expect(manager.snapshot().spiders).toEqual([]);
    pilot.position = { x: 3700, y: 5000 };
    step(60, new Set(['2,2']));
    expect(manager.snapshot().spiders).toEqual([]);
  }
);

test('multiplayer nest creation and sleeping guards share the same active population limit', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const resources: SpiderResource[] = Array.from({ length: 8 }, (_, index) => ({
    id: `deposit-${index}`,
    position: { x: -35000 + index * SPIDER.NEST_SPACING, y: 5000 },
    value: 2,
  }));
  const players = resources.map((resource, index) => ({
    id: `pilot-${index}`,
    position: { x: resource.position.x - 2000, y: resource.position.y },
    health: 100,
    exploding: false,
  }));
  manager.advance({
    players: players.slice(0, 1),
    resources: () => resources,
    completedSectors: new Set(),
    nowFrame: 1,
  });
  const sleepingIds = manager.snapshot().spiders.map(({ id }) => id);
  expect(sleepingIds).toHaveLength(7);
  manager.advance({
    players: players.slice(1),
    resources: () => resources,
    completedSectors: new Set(),
    nowFrame: 61,
  });
  expect(manager.snapshot().spiders).toHaveLength(42);
  expect(manager.snapshot().spiders.some(({ id }) => sleepingIds.includes(id))).toBe(false);
  manager.advance({
    players,
    resources: () => resources,
    completedSectors: new Set(),
    nowFrame: 121,
  });
  expect(manager.snapshot().spiders).toHaveLength(SPIDER.MAX_ACTIVE);
  expect(manager.snapshot().spiders.filter(({ id }) => sleepingIds.includes(id))).toHaveLength(6);
});
