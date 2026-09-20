import { expect, test } from 'vitest';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
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

test('ambient predators stay bounded and distribute their spawn attempts across pilots', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const players = [
    actorAt({ x: 5000, y: 5000 }),
    { ...actorAt({ x: -5000, y: -5000 }), id: 'other' },
  ];
  for (let cycle = 0; cycle < SPIDER.MAX_ACTIVE + 3; cycle++) {
    manager.advance({
      players,
      completedSectors,
      nowFrame: cycle * SPIDER.SPAWN_INTERVAL_FRAMES + 1,
    });
  }
  const { spiders } = manager.snapshot();
  expect(spiders).toHaveLength(SPIDER.MAX_ACTIVE);
  expect(spiders.some((spider) => spider.position.x < 0)).toBe(true);
  expect(spiders.some((spider) => spider.position.x > 0)).toBe(true);
});

test('new spiders arrive no more than once every thirty seconds', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const players = [actorAt({ x: 5000, y: 5000 })];
  manager.advance({ players, completedSectors, nowFrame: 1 });
  expect(manager.snapshot().spiders).toHaveLength(1);
  manager.advance({ players, completedSectors, nowFrame: 1800 });
  expect(manager.snapshot().spiders).toHaveLength(1);
  manager.advance({ players, completedSectors, nowFrame: 1801 });
  expect(manager.snapshot().spiders).toHaveLength(2);
});
