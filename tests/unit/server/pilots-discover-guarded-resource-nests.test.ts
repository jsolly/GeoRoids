import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import { type SpiderResource, spiderResources } from '../../../server/core/spiderResources';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { TOWN_HEARTH } from '../../../shared/furnaces';
import { SPIDER } from '../../../shared/terrainSpider';
import type { AsteroidData, Position } from '../../../shared-types';
import { DAMAGE, ROID } from '../../../src/constants';

const home = { x: 15_000, y: 5_000 };
const approach = { x: home.x - 2_000, y: home.y };
const homeSector = '7,2';
const nestCellId = '1,0';
function setup(value: SpiderResource['value'] = 1) {
  const manager = new TerrainSpiderManager(() => 0.5);
  const pilot = { id: 'pilot', position: { ...approach }, health: 100, exploding: false };
  const resource: SpiderResource = { id: 'ore', position: home, value };
  const resources = () => [resource];
  let frame = 0;
  const step = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      manager.advance({ players: [pilot], resources, nowFrame: ++frame });
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
  pilot.position = { ...approach };
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

test('nests never materialize beside a pilot or in a furnace yard', () => {
  const nearby = setup();
  nearby.pilot.position = { ...home };
  nearby.step(60);
  expect(nearby.manager.snapshot().spiders).toEqual([]);
  const worksYard = new TerrainSpiderManager(() => 0.5);
  const worksPilot = {
    id: 'pilot',
    position: { x: TOWN_HEARTH.position.x - 2_000, y: TOWN_HEARTH.position.y },
    health: 100,
    exploding: false,
  };
  worksYard.advance({
    players: [worksPilot],
    resources: () => [{ id: 'ore', position: { ...TOWN_HEARTH.position }, value: 1 }],
    nowFrame: 1,
  });
  expect(worksYard.snapshot().nests).toEqual([]);
  expect(worksYard.snapshot().spiders).toEqual([]);
  const { manager, step } = setup();
  step(60);
  expect(manager.snapshot().spiders.length).toBeGreaterThan(0);
});

test('valuable resources away from a widely spaced nest site remain unguarded', () => {
  const { manager, resource, pilot, step } = setup(2);
  resource.position = { x: 2200, y: 2200 };
  pilot.position = { x: 4000, y: 2200 };
  step(120);
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
  pilot.position = { ...approach };
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

test('multiplayer nest creation and sleeping guards share the same active population limit', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const resources: SpiderResource[] = Array.from({ length: 8 }, (_, index) => ({
    id: `deposit-${index}`,
    position: { x: -35_000 + index * SPIDER.NEST_SPACING, y: 15_000 },
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
    nowFrame: 1,
  });
  const sleepingIds = manager.snapshot().spiders.map(({ id }) => id);
  expect(sleepingIds).toHaveLength(7);
  manager.advance({
    players: players.slice(1),
    resources: () => resources,
    nowFrame: 61,
  });
  expect(manager.snapshot().spiders).toHaveLength(42);
  expect(manager.snapshot().spiders.some(({ id }) => sleepingIds.includes(id))).toBe(false);
  manager.advance({
    players,
    resources: () => resources,
    nowFrame: 121,
  });
  expect(manager.snapshot().spiders).toHaveLength(SPIDER.MAX_ACTIVE);
  expect(manager.snapshot().spiders.filter(({ id }) => sleepingIds.includes(id))).toHaveLength(6);
});

test('the map marks the guarded deposit while its spiders chase, sleep, and remain cleared', () => {
  const { manager, pilot, resource, step } = setup();
  step();
  const marker = { id: nestCellId, resourceId: resource.id, position: { ...home } };
  expect(manager.snapshot().nests).toEqual([marker]);
  pilot.position = { ...home };
  step(120);
  expect(manager.snapshot().spiders.some((spider) => spider.phase === 'hunting')).toBe(true);
  expect(manager.snapshot().nests).toEqual([marker]);
  manager.suspend();
  expect(manager.snapshot().spiders).toEqual([]);
  expect(manager.snapshot().nests).toEqual([marker]);
  pilot.position = { ...approach };
  step(60);
  for (const spider of manager.snapshot().spiders) {
    manager.removeSpider(spider.id);
  }
  step(60);
  expect(manager.snapshot().spiders).toEqual([]);
  expect(manager.snapshot().nests).toEqual([marker]);
});

test.each(['collected', 'moved', 'replaced'] as const)(
  'a %s deposit no longer advertises the old nest on the map',
  (change) => {
    const manager = new TerrainSpiderManager(() => 0.5);
    const pilot = { id: 'pilot', position: { ...approach }, health: 100, exploding: false };
    let resources: SpiderResource[] = [{ id: 'ore', position: { ...home }, value: 1 }];
    const advance = (nowFrame: number) =>
      manager.advance({ players: [pilot], resources: () => resources, nowFrame });
    advance(1);
    expect(manager.snapshot().nests).toHaveLength(1);
    if (change === 'collected') {
      resources = [];
    }
    if (change === 'moved') {
      resources = [{ id: 'ore', position: { x: home.x + 10, y: home.y }, value: 1 }];
    }
    if (change === 'replaced') {
      resources = [{ id: 'other-ore', position: { ...home }, value: 1 }];
    }
    advance(61);
    expect(manager.snapshot().nests).toEqual([]);
  }
);

test('map snapshots reuse the scheduled resource refresh and roaming spiders add no nests', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const pilot = { id: 'pilot', position: { ...approach }, health: 100, exploding: false };
  let reads = 0;
  const resources = (): SpiderResource[] => {
    reads++;
    return [{ id: 'ore', position: home, value: 1 }];
  };
  for (let nowFrame = 1; nowFrame <= 120; nowFrame++) {
    manager.advance({
      players: [pilot],
      resources,
      nowFrame,
    });
    manager.snapshot();
  }
  expect(reads).toBe(2);
  manager.clear();
  manager.spawnSpider(home);
  expect(manager.snapshot().nests).toEqual([]);
});

test.each(['collected', 'moved'] as const)(
  'a discovered nest survives sector sleep and revisit, then hides its %s dormant resource',
  (change) => {
    const deposit: AsteroidData = {
      id: 'aaa-nest-deposit',
      position: { ...home },
      velocity: { x: 0, y: 0 },
      size: ROID.COLOSSAL_SIZE,
      jaggedness: 0.2,
      rotation: 0,
      angularVelocity: 0,
      health: 75,
      maxHealth: 75,
      vertices: 4,
      offsets: [1, 1, 1, 1],
    };
    const field = new RegionalAsteroidField(42, new Map([[homeSector, [deposit]]]));
    const rocks = new AsteroidManager(new RNGService(42));
    const manager = new TerrainSpiderManager(() => 0.5);
    const pilot = { id: 'pilot', position: { ...approach }, health: 100, exploding: false };
    const advance = (nowFrame: number) => {
      field.update(rocks, [pilot.position]);
      manager.advance({
        players: [pilot],
        nowFrame,
        resources: () => spiderResources(rocks.getAllAsteroids(), [], []),
        dormantResource: (id, position) => {
          const dormant = field.dormantAsteroid(id, position);
          return dormant ? spiderResources([dormant], [], [])[0] : undefined;
        },
      });
    };
    const marker = { id: nestCellId, resourceId: deposit.id, position: { ...home } };
    advance(1);
    expect(manager.snapshot().nests).toContainEqual(marker);
    pilot.position = { x: -20000, y: -20000 };
    advance(61);
    expect(rocks.getAsteroid(deposit.id)).toBeUndefined();
    expect(field.dormantAsteroid(deposit.id, home)).toBeDefined();
    expect(manager.snapshot().nests).toContainEqual(marker);
    pilot.position = { ...approach };
    advance(121);
    expect(rocks.getAsteroid(deposit.id)).toBeDefined();
    expect(manager.snapshot().nests).toContainEqual(marker);
    if (change === 'collected') {
      rocks.removeAsteroid(deposit.id);
    } else {
      rocks.updateAsteroid(deposit.id, { position: { x: home.x + 100, y: home.y } });
    }
    // Leave before the next nest refresh: depletion must not be mistaken for unloading.
    pilot.position = { x: -20000, y: -20000 };
    advance(181);
    expect(manager.snapshot().nests.some((nest) => nest.resourceId === deposit.id)).toBe(false);
    pilot.position = { ...approach };
    advance(241);
    expect(manager.snapshot().nests.some((nest) => nest.resourceId === deposit.id)).toBe(false);
  }
);
