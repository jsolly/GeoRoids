/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { BeltCrawlerManager } from '../../../server/core/BeltCrawlerManager';
import { EntityManager } from '../../../server/core/EntityManager';
import { GlowtoyManager } from '../../../server/core/GlowtoyManager';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { SatellitePickupManager } from '../../../server/core/SatellitePickupManager';
import { SpiderField } from '../../../server/core/SpiderField';
import { SpiderPopulationBudget } from '../../../server/core/SpiderPopulationBudget';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { CooperativeCampaign } from '../../../server/world/CooperativeCampaign';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { SPIDER } from '../../../shared/terrainSpider';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';
import { useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();
afterEach(() => vi.restoreAllMocks());

function rock(id: string, x = 15_000, y = 5_000): AsteroidData {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    size: 100,
    health: 100,
    maxHealth: 100,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
  };
}

function arrange() {
  const random = new RNGService(22);
  const actors = new EntityManager(random, () => 42_000);
  const rocks = new AsteroidManager(random);
  const terrain = new TerrainSpiderManager(() => 0.5);
  const crawlers = new BeltCrawlerManager((id) => rocks.getAsteroid(id));
  const campaign = new CooperativeCampaign();
  const population = new SpiderPopulationBudget({ campaign, spiders: terrain, crawlers });
  const regional = new RegionalAsteroidField(22);
  const loot = new LootManager(random, () => 42_000);
  const satellites = new SatellitePickupManager(random);
  const glowtoys = new GlowtoyManager({
    actors,
    field: rocks.spatialIndex(),
    points: loot,
    markFieldDirty: () => regional.requestFullFlush(),
  });
  const field = new SpiderField({
    actors,
    terrain,
    crawlers,
    population,
    rocks,
    regional,
    loot,
    satellites,
    glowtoys,
  });
  return { actors, rocks, terrain, crawlers, population, loot, satellites, field };
}

function captive(world: ReturnType<typeof arrange>, socket = new RecordingSocket()) {
  const pilot = world.actors.addPlayer('hauler', 'Hauler', socket, { x: 6970, y: 3000 }, 'hauler');
  pilot.spawnProtectionTimer = 0;
  const body = world.terrain.spawnSpider({ x: 7000, y: 3000 });
  assert(body);
  pilot.harpoonTargetId = body.id;
  return { pilot, body };
}

test('a real captive bite drains once and a later body removal invalidates the queued intent', () => {
  const world = arrange();
  const { pilot, body } = captive(world);
  const bite = { spiderId: body.id, targetId: pilot.id, attackerId: 'spider' } as const;
  world.field.advance(1);
  expect(world.field.drainAttacks()).toEqual([bite]);
  expect(world.field.drainAttacks()).toEqual([]);
  world.field.advance(SPIDER.BITE_COOLDOWN_FRAMES);
  expect(world.field.drainAttacks()).toEqual([]);
  world.field.advance(1 + SPIDER.BITE_COOLDOWN_FRAMES);
  expect(world.field.isAttackActive(bite)).toBe(true);
  world.terrain.removeSpider(body.id);
  expect(world.field.isAttackActive(bite)).toBe(false);
  // The queue retains raw intents. Combat must recheck each one when it consumes it.
  expect(world.field.drainAttacks()).toEqual([bite]);
});

test.each(['connected human', 'worker bot', 'disconnected human'] as const)(
  'a newly registered %s has the original live actor admission',
  (kind) => {
    const world = arrange();
    const { pilot, body } = captive(world);
    if (kind !== 'connected human') {
      delete pilot.ws;
    }
    if (kind === 'worker bot') {
      pilot.botRole = 'worker';
    }
    world.field.advance(1);
    expect(world.field.drainAttacks()).toEqual(
      kind === 'disconnected human'
        ? []
        : [{ spiderId: body.id, targetId: pilot.id, attackerId: 'spider' }]
    );
    expect(world.terrain.getBody(body.id) !== undefined).toBe(kind !== 'disconnected human');
  }
);

test('clearing pending bites retains the living body and its existing cooldown', () => {
  const world = arrange();
  const { pilot, body } = captive(world);
  world.field.advance(1);
  world.field.clearPendingAttacks();
  expect(world.field.drainAttacks()).toEqual([]);
  expect(world.terrain.getBody(body.id)?.health).toBe(SPIDER.MAX_HEALTH);
  world.field.advance(SPIDER.BITE_COOLDOWN_FRAMES);
  expect(world.field.drainAttacks()).toEqual([]);
  world.field.advance(1 + SPIDER.BITE_COOLDOWN_FRAMES);
  expect(world.field.drainAttacks()).toEqual([
    { spiderId: body.id, targetId: pilot.id, attackerId: 'spider' },
  ]);
});

test.each([2, 3])(
  'population failure %i preserves the original pending-bite boundary',
  (failure) => {
    const world = arrange();
    const { pilot, body } = captive(world);
    const refresh = world.population.refresh.bind(world.population);
    const cause = new Error(`budget failure ${failure}`);
    let calls = 0;
    vi.spyOn(world.population, 'refresh').mockImplementation(() => {
      if (++calls === failure) {
        throw cause;
      }
      refresh();
    });
    expect(() => world.field.advance(1)).toThrow(cause);
    expect(world.field.drainAttacks()).toEqual(
      failure === 2 ? [] : [{ spiderId: body.id, targetId: pilot.id, attackerId: 'spider' }]
    );
  }
);

test('a real crawler bite becomes invalid when its host leaves the live spatial index', () => {
  const world = arrange();
  const host = rock('belt-1-0-0', 7000, 3000);
  world.rocks.addAsteroid(host);
  const pilot = world.actors.addPlayer(
    'pilot',
    'Pilot',
    new RecordingSocket(),
    { x: 7165, y: 2990 },
    'scout'
  );
  pilot.spawnProtectionTimer = 0;
  let bite: ReturnType<SpiderField['drainAttacks']>[number] | undefined;
  for (let frame = 0; frame < 90 && !bite; frame++) {
    world.field.advance(frame);
    bite = world.field.drainAttacks().find((attack) => attack.spiderId.startsWith('belt-crawler:'));
  }
  assert(bite, 'Expected an actual surface lunge');
  expect(bite.targetId).toBe(pilot.id);
  expect(world.field.isAttackActive(bite)).toBe(true);
  world.rocks.removeAsteroid(host.id);
  expect(world.field.isAttackActive(bite)).toBe(false);
});

test('a same-ID loose satellite takes anchor precedence and nest rewards appear only once', () => {
  const world = arrange();
  const [created] = world.satellites.createPickups(1);
  assert(created);
  const pickup = world.satellites.getPickup(created.id);
  assert(pickup);
  pickup.position = { x: 15_100, y: 5000 };
  world.rocks.addAsteroid(rock(pickup.id));
  world.actors.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 13_000, y: 5000 });
  world.field.advance(1);
  expect(world.terrain.snapshot().spiders).toHaveLength(SPIDER.NEST_GUARDS);
  // The rock nominated this home, but the higher-precedence satellite has moved.
  expect(world.terrain.snapshot().nests).toEqual([]);
  const cache = world.loot.getAll().map(({ id, kind, position }) => ({ id, kind, position }));
  expect(cache.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['shard', 'tap', 'silk']));
  expect(cache.filter(({ kind }) => kind === 'shard')).toHaveLength(3);
  const salvage = world.satellites.getAllPickups().filter((item) => item.id !== pickup.id);
  expect(salvage).toHaveLength(1);
  expect(salvage[0]?.position).toEqual({ x: 14_900, y: 4900 });
  pickup.state = 'stored';
  pickup.ownerId = 'pilot';
  world.field.advance(61);
  expect(world.terrain.snapshot().nests).toEqual([
    { id: '3,1', resourceId: pickup.id, position: { x: 15_000, y: 5000 }, cleared: false },
  ]);
  expect(world.loot.getAll().map(({ id, kind, position }) => ({ id, kind, position }))).toEqual(
    cache
  );
  expect(world.satellites.getAllPickups().filter((item) => item.id !== pickup.id)).toEqual(salvage);
});

test('a vanished terrain target releases its cable while an unrelated rock tow survives', () => {
  const world = arrange();
  const { pilot, body } = captive(world);
  pilot.health = 0;
  const host = rock('unrelated-rock', -9000, 3000);
  world.rocks.addAsteroid(host);
  const other = world.actors.addPlayer(
    'other',
    'Other',
    new RecordingSocket(),
    { x: -9130, y: 3000 },
    'hauler'
  );
  other.spawnProtectionTimer = 0;
  other.harpoonTargetId = host.id;
  world.field.advance(1);
  expect(world.terrain.getBody(body.id)).toBeUndefined();
  expect(pilot.harpoonTargetId).toBeNull();
  expect(other.harpoonTargetId).toBe(host.id);
  expect(world.rocks.getAsteroid(host.id)).toBe(host);
  expect(other.health).toBe(other.maxHealth);
});
