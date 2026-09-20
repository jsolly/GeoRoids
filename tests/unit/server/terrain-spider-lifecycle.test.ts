import { expect, test } from 'vitest';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { FURNACES } from '../../../shared/furnaces';
import { shipOverlapsCompletedSector } from '../../../shared/sectors';
import { SPIDER } from '../../../shared/terrainSpider';
import { DAMAGE } from '../../../src/constants';

const completedSectors = new Set<string>();
function actorAt(position: { x: number; y: number }) {
  return { id: 'pilot', position, health: 100, exploding: false, radius: 20 };
}

test('a spider pursues and bites nearby prey then releases a pilot who escapes', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const spider = manager.spawnSpider({ x: 2200, y: 2200 });
  const pilot = actorAt({ x: 2425, y: 2325 });
  manager.advance({ players: [pilot], completedSectors, nowFrame: 1 });
  expect(manager.snapshot().spiders[0]?.phase).toBe('hunting');
  let bites = 0;
  for (let frame = 2; frame < 160; frame++) {
    bites += manager.advance({ players: [pilot], completedSectors, nowFrame: frame }).length;
  }
  expect(bites).toBeGreaterThan(0);
  pilot.position.x += SPIDER.HUNT_RELEASE_DISTANCE + 1;
  manager.advance({ players: [pilot], completedSectors, nowFrame: 160 });
  expect(manager.snapshot().spiders.find((row) => row.id === spider?.id)?.targetId).toBeNull();
});

test('three regular laser hits kill a spider and cancel its pending bite', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  manager.spawnSpider({ x: 2200, y: 2200 });
  const pilot = actorAt({ x: 2200, y: 2200 });
  manager.advance({ players: [pilot], completedSectors, nowFrame: 1 });
  const [bite] = manager.advance({ players: [pilot], completedSectors, nowFrame: 2 });
  expect(bite).toBeDefined();
  const start = { x: 2100, y: 2200 };
  const end = { x: 2300, y: 2200 };
  for (let hits = 1; hits <= 3; hits++) {
    expect(manager.resolveLaserHit(start, end, DAMAGE.LASER_HIT)?.kind).toBe('spider');
    if (hits < 3) {
      expect(manager.snapshot().spiders[0]?.health).toBe(
        SPIDER.MAX_HEALTH - DAMAGE.LASER_HIT * hits
      );
      expect(manager.snapshot().spiders[0]?.phase).toBe('hunting');
    }
  }
  expect(manager.snapshot().spiders).toEqual([]);
  if (bite) {
    expect(manager.isAttackActive(bite)).toBe(false);
  }
});

test('completed-sector protection covers the full spider footprint and protected prey', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  manager.spawnSpider({ x: 1980, y: 1900 });
  const closed = new Set(['1,0']);
  const pilot = actorAt({ x: 2100, y: 1900 });
  manager.advance({ players: [pilot], completedSectors: closed, nowFrame: 1 });
  expect(manager.snapshot().spiders).toEqual([]);
  manager.spawnSpider({ x: 1900, y: 1900 });
  for (let frame = 2; frame < 180; frame++) {
    expect(
      manager.advance({ players: [pilot], completedSectors: closed, nowFrame: frame })
    ).toEqual([]);
    for (const spider of manager.snapshot().spiders) {
      expect(shipOverlapsCompletedSector(spider.position, SPIDER.HIT_RADIUS, closed)).toBe(false);
      expect(spider.targetId).toBeNull();
    }
  }
});

test('roamers wait minutes even on the first arrival and postpone new attacks during a hunt', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const players = [actorAt({ x: 7_000, y: 3_000 })];
  manager.advance({ players, completedSectors, nowFrame: 1 });
  manager.advance({ players, completedSectors, nowFrame: 1801 });
  expect(manager.snapshot().spiders).toEqual([]);
  const interval = (SPIDER.SPAWN_INTERVAL_FRAMES + SPIDER.SPAWN_INTERVAL_MAX_FRAMES) / 2;
  manager.advance({ players, completedSectors, nowFrame: interval });
  expect(manager.snapshot().spiders).toEqual([]);
  manager.advance({ players, completedSectors, nowFrame: interval + 1 });
  expect(manager.snapshot().spiders).toHaveLength(1);
  manager.advance({ players, completedSectors, nowFrame: interval * 2 + 1 });
  expect(manager.snapshot().spiders).toHaveLength(SPIDER.MAX_ROAMERS);
});

test('failed roaming attempts wait another full interval instead of ambushing on leaving safety', () => {
  const manager = new TerrainSpiderManager(() => 0);
  const pilot = actorAt({ x: 100, y: 100 });
  const options = { players: [pilot], completedSectors: new Set(['0,0']) };
  manager.advance({ ...options, nowFrame: 1 });
  manager.advance({ ...options, nowFrame: SPIDER.SPAWN_INTERVAL_FRAMES + 1 });
  expect(manager.snapshot().spiders).toEqual([]);
  pilot.position = { x: 7_000, y: 3_000 };
  manager.advance({ ...options, nowFrame: SPIDER.SPAWN_INTERVAL_FRAMES + 2 });
  expect(manager.snapshot().spiders).toEqual([]);
  manager.advance({ ...options, nowFrame: SPIDER.SPAWN_INTERVAL_FRAMES * 2 + 1 });
  expect(manager.snapshot().spiders).toHaveLength(1);
});

test('a roaming spawn keeps its distance from every pilot, not only its chosen target', () => {
  const manager = new TerrainSpiderManager(() => 0);
  const players = [
    actorAt({ x: 7_000, y: 3_000 }),
    { ...actorAt({ x: 9_100, y: 3_000 }), id: 'z-other' },
  ];
  manager.advance({ players, completedSectors, nowFrame: 1 });
  manager.advance({ players, completedSectors, nowFrame: SPIDER.SPAWN_INTERVAL_FRAMES + 1 });
  for (const spider of manager.snapshot().spiders) {
    for (const pilot of players) {
      expect(
        Math.hypot(spider.position.x - pilot.position.x, spider.position.y - pilot.position.y)
      ).toBeGreaterThanOrEqual(SPIDER.NEST_SPAWN_SAFE_RADIUS);
    }
  }
  expect(manager.snapshot().spiders).toHaveLength(1);
});

test('a non-hunting roamer still occupies the roaming population slot when a new spawn is due', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const roamer = manager.spawnSpider({ x: 2200, y: 2200 });
  const players = [actorAt({ x: 7_000, y: 3_000 })];
  manager.advance({ players, completedSectors, nowFrame: 1 });
  expect(manager.snapshot().spiders[0]?.phase).toBe('scuttling');
  manager.advance({ players, completedSectors, nowFrame: SPIDER.SPAWN_INTERVAL_MAX_FRAMES + 1 });
  expect(manager.snapshot().spiders.map(({ id }) => id)).toEqual([roamer?.id]);
});

test('a spider released near a furnace retreats out of protection without attacking the pilot', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const furnace = FURNACES.find((site) => site.id === 'works-1-0');
  if (!furnace) {
    throw new Error('Expected eastern furnace');
  }
  const spawned = manager.spawnSpider({ x: furnace.position.x + 500, y: furnace.position.y });
  const body = spawned ? manager.getBody(spawned.id) : undefined;
  if (!body) {
    throw new Error('Expected spider');
  }
  body.velocity = { x: -200, y: 0 };
  const pilot = actorAt({ x: furnace.position.x + 300, y: furnace.position.y });
  const options = { players: [pilot], completedSectors };
  manager.advance({ ...options, nowFrame: 1, towedIds: new Set([body.id]) });
  expect(body.position.x).toBe(furnace.position.x + 300);
  const retreatFrames = Math.ceil(
    (SPIDER.FURNACE_SAFE_RADIUS + SPIDER.HIT_RADIUS - 300) / SPIDER.SCUTTLE_SPEED
  );
  for (let frame = 2; frame <= retreatFrames + 1; frame++) {
    expect(manager.advance({ ...options, nowFrame: frame })).toEqual([]);
  }
  expect(manager.getBody(body.id)).toBe(body);
  expect(body.position.x).toBeGreaterThanOrEqual(
    furnace.position.x + SPIDER.FURNACE_SAFE_RADIUS + SPIDER.HIT_RADIUS
  );
  expect(body.targetId).toBeNull();
  expect(manager.snapshot().consumed).toEqual([]);
});

test('released spiders escape overlapping central protection and burn if retreat crosses an intake', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const spawned = manager.spawnSpider({ x: 0, y: -1100 });
  const body = spawned ? manager.getBody(spawned.id) : undefined;
  if (!body) {
    throw new Error('Expected spider');
  }
  // Arrange a previously towed spider on the inner side of the north Works.
  body.position = { x: 0, y: -400 };
  const pilot = actorAt({ x: 0, y: -400 });
  const options = { players: [pilot], completedSectors };
  manager.advance({ ...options, nowFrame: 1, towedIds: new Set([body.id]) });
  expect(manager.getBody(body.id)).toBe(body);
  for (let frame = 2; frame <= 300; frame++) {
    manager.advance({ ...options, nowFrame: frame });
    if (!manager.getBody(body.id)) {
      break;
    }
  }
  expect(manager.getBody(body.id)).toBeUndefined();
  expect(manager.snapshot().consumed).toEqual([
    expect.objectContaining({ id: body.id, furnaceId: 'north' }),
  ]);
});
