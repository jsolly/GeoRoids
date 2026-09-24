import { describe, expect, test } from 'vitest';
import { BeltCrawlerManager } from '../../../server/core/BeltCrawlerManager';
import type { SpiderAttack } from '../../../server/core/TerrainSpiderManager';
import { beltAsteroid, beltSlots } from '../../../shared/asteroidBelt';
import { BELT_CRAWLER } from '../../../shared/beltCrawler';
import type { AsteroidData, Position } from '../../../shared-types';

function host(): AsteroidData {
  return {
    id: 'belt-1-0-0',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 100,
    health: 100,
    maxHealth: 100,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}
function pilot(position: Position) {
  return { id: 'pilot', position, health: 100, exploding: false, radius: 18 };
}

describe('belt surface predators', () => {
  test('a lone spider follows its towed rotating host', () => {
    const manager = new BeltCrawlerManager();
    const rock = host();
    manager.advance({ rocks: [rock], players: [], nowFrame: 0 });
    const before = manager.snapshot();
    expect(before).toHaveLength(1);
    expect(before[0]?.position.x).toBeGreaterThan(100);
    rock.position = { x: 500, y: 200 };
    rock.rotation = Math.PI / 2;
    manager.advance({ rocks: [rock], players: [], nowFrame: 1 });
    const moved = manager.snapshot()[0];
    expect(moved?.crawler?.anchor.x).toBeCloseTo(500);
    expect(moved?.crawler?.anchor.y).toBeCloseTo(300);
    manager.advance({ rocks: [], players: [], nowFrame: 2 });
    expect(manager.snapshot()).toEqual([]);
  });

  test('far-side spiders crawl around the rock before they can attack', () => {
    const manager = new BeltCrawlerManager();
    const rock = host();
    const player = pilot({ x: -165, y: -10 });
    const attacks: SpiderAttack[] = [];
    for (let frame = 0; frame < 80; frame++) {
      attacks.push(...manager.advance({ rocks: [rock], players: [player], nowFrame: frame }));
    }
    expect(attacks).toEqual([]);
    const far = manager.snapshot().find((body) => body.id.endsWith(':0'));
    expect(far?.position.x).toBeLessThan(110);
    expect(far?.crawler?.phase).toBe('crawling');
  });

  test('windup warns pilots and a lunge retracts back to its surface', () => {
    const manager = new BeltCrawlerManager();
    const rock = host();
    const player = pilot({ x: 165, y: -10 });
    let strikes = 0;
    for (let frame = 0; frame < BELT_CRAWLER.WINDUP_FRAMES; frame++) {
      strikes += manager.advance({ rocks: [rock], players: [player], nowFrame: frame }).length;
    }
    expect(strikes).toBe(0);
    expect(manager.snapshot()[0]?.crawler?.phase).toBe('winding');
    for (
      let frame = BELT_CRAWLER.WINDUP_FRAMES;
      frame <= BELT_CRAWLER.WINDUP_FRAMES + BELT_CRAWLER.LUNGE_FRAMES;
      frame++
    ) {
      strikes += manager.advance({ rocks: [rock], players: [player], nowFrame: frame }).length;
    }
    expect(strikes).toBe(1);
    const body = manager.snapshot()[0];
    expect(body?.crawler?.phase).toBe('recovering');
    expect(
      Math.hypot(
        (body?.position.x ?? 0) - (body?.crawler?.anchor.x ?? 0),
        (body?.position.y ?? 0) - (body?.crawler?.anchor.y ?? 0)
      )
    ).toBeCloseTo(BELT_CRAWLER.SURFACE_OFFSET);
  });

  test('solid rock shields spiders from laser shots and killed crawlers stay dead after reload', () => {
    const manager = new BeltCrawlerManager();
    const rock = host();
    rock.beltCrawlerHealth = [BELT_CRAWLER.MAX_HEALTH];
    manager.advance({ rocks: [rock], players: [], nowFrame: 0 });
    const body = manager.snapshot()[0];
    expect(body).toBeDefined();
    const y = body?.position.y ?? 0;
    expect(manager.findLaserHit({ x: -200, y }, { x: 150, y })).toBeNull();
    expect(
      manager.resolveLaserHit({ x: 200, y }, { x: 90, y }, BELT_CRAWLER.MAX_HEALTH)
    ).not.toBeNull();
    expect(rock.beltCrawlerHealth).toEqual([0]);
    manager.clear();
    manager.advance({ rocks: [structuredClone(rock)], players: [], nowFrame: 1 });
    expect(manager.snapshot()).toEqual([]);
  });

  test('an intervening asteroid blocks attacks and host destruction invalidates a pending bite', () => {
    const manager = new BeltCrawlerManager();
    const rock = host();
    const shield = { ...host(), id: 'shield', size: 14, position: { x: 142, y: -10 } };
    const player = pilot({ x: 165, y: -10 });
    for (let frame = 0; frame < 90; frame++) {
      expect(
        manager.advance({ rocks: [rock, shield], players: [player], nowFrame: frame })
      ).toEqual([]);
    }
    manager.clear();
    rock.beltCrawlerHealth = [BELT_CRAWLER.MAX_HEALTH];
    let attack: SpiderAttack | undefined;
    for (let frame = 90; frame < 160; frame++) {
      attack = manager.advance({ rocks: [rock], players: [player], nowFrame: frame })[0];
      if (attack) {
        break;
      }
    }
    expect(attack).toBeDefined();
    if (!attack) {
      throw new Error('Expected lunge');
    }
    expect(manager.isAttackActive(attack, [rock])).toBe(true);
    expect(manager.isAttackActive(attack, [])).toBe(false);
  });
});

test('dense active sectors and overlapping rock piles never overflow the geometry batch limit', () => {
  const manager = new BeltCrawlerManager();
  const rock = host();
  const blockers = Array.from({ length: 600 }, (_, index) => ({
    ...host(),
    id: `ordinary-${index}`,
    size: 14,
    position: { x: 142, y: -10 },
  }));
  const player = pilot({ x: 165, y: -10 });
  expect(manager.advance({ rocks: [rock, ...blockers], players: [player], nowFrame: 0 })).toEqual(
    []
  );
  expect(() => manager.findLaserHit({ x: 200, y: -10 }, { x: 90, y: -10 })).not.toThrow();
  expect(manager.findLaserHit({ x: 200, y: -10 }, { x: 90, y: -10 })).toBeNull();
});

test('a later shot ignores a host and cover destroyed earlier in the same frame', () => {
  const rock = host();
  const shield = { ...host(), id: 'cover', size: 12, position: { x: 142, y: 10 } };
  const live = new Map([
    [rock.id, rock],
    [shield.id, shield],
  ]);
  const manager = new BeltCrawlerManager((id) => live.get(id));
  manager.advance({ rocks: [...live.values()], players: [], nowFrame: 0 });
  const start = { x: 200, y: 10 };
  const end = { x: 95, y: 10 };
  expect(manager.findLaserHit(start, end)).toBeNull();
  live.delete(shield.id);
  expect(manager.findLaserHit(start, end)?.spiderId).toBe(`belt-crawler:${rock.id}:0`);
  live.delete(rock.id);
  expect(manager.findLaserHit(start, end)).toBeNull();
});

test('a whole belt has eighteen lone guards and discards old paired guard state', () => {
  const manager = new BeltCrawlerManager();
  const rocks = beltSlots().map((slot) => ({
    ...beltAsteroid(1, slot, 0),
    beltCrawlerHealth: [75, 75],
  }));
  manager.advance({ rocks, players: [], nowFrame: 0 });
  const spiders = manager.snapshot();
  expect(spiders).toHaveLength(18);
  expect(new Set(spiders.map((s) => s.crawler?.hostId)).size).toBe(18);
  expect(spiders.every((s) => s.id.endsWith(':0'))).toBe(true);
});

test('a wounded spider escapes a destroyed rock, stays shootable, and survives sleeping on its new host', () => {
  const manager = new BeltCrawlerManager();
  const rock = host();
  rock.health = 150;
  const destination = { ...host(), id: 'ordinary-destination', position: { x: 300, y: 0 } };
  manager.advance({ rocks: [rock, destination], players: [], nowFrame: 0 });
  const original = manager.snapshot()[0];
  if (!original) {
    throw new Error('Expected crawler');
  }
  const y = original.position.y;
  const graze = BELT_CRAWLER.MAX_HEALTH / 2;
  manager.resolveLaserHit({ x: 180, y }, { x: 100, y }, graze);
  expect(rock.health).toBe(150);
  manager.escapeDestroyedHost(rock, [destination], 1);
  expect(manager.snapshot()[0]).toMatchObject({
    id: original.id,
    health: BELT_CRAWLER.MAX_HEALTH - graze,
    crawler: { phase: 'escaping', hostId: destination.id },
  });
  expect(rock.beltCrawlerHealth).toEqual([0]);
  expect(destination.beltCrawlerHealth).toEqual([BELT_CRAWLER.MAX_HEALTH - graze]);
  manager.advance({ rocks: [destination], players: [pilot({ x: 160, y: 0 })], nowFrame: 19 });
  const airborne = manager.snapshot()[0];
  expect(airborne?.position.x).toBeGreaterThan(original.position.x);
  expect(airborne?.crawler?.progress).toBeCloseTo(0.5);
  if (!airborne) {
    throw new Error('Expected airborne crawler');
  }
  expect(
    manager.findLaserHit({ x: airborne.position.x, y: -100 }, { x: airborne.position.x, y: 100 })
      ?.spiderId
  ).toBe(original.id);
  manager.advance({ rocks: [], players: [], nowFrame: 20 });
  expect(manager.snapshot()).toEqual([]);
  manager.advance({ rocks: [structuredClone(destination)], players: [], nowFrame: 21 });
  expect(manager.snapshot()).toHaveLength(1);
  expect(manager.snapshot()[0]).toMatchObject({
    id: original.id,
    health: BELT_CRAWLER.MAX_HEALTH - graze,
    crawler: { hostId: destination.id, phase: 'crawling' },
  });
  manager.clear();
  manager.advance({ rocks: [structuredClone(destination)], players: [], nowFrame: 22 });
  expect(manager.snapshot()[0]?.health).toBe(BELT_CRAWLER.MAX_HEALTH - graze);
});

test('escape preserves the destination native guard and does not resurrect a killed migrant', () => {
  const manager = new BeltCrawlerManager();
  const rock = host();
  const destination = { ...host(), id: 'belt-1-6-0', position: { x: 300, y: 0 } };
  manager.advance({ rocks: [rock, destination], players: [], nowFrame: 0 });
  manager.escapeDestroyedHost(rock, [destination], 1);
  manager.advance({ rocks: [destination], players: [], nowFrame: 37 });
  expect(manager.snapshot()).toHaveLength(2);
  const migrant = manager.snapshot().find((body) => body.id === `belt-crawler:${rock.id}:0`);
  if (!migrant) {
    throw new Error('Expected migrant');
  }
  manager.resolveLaserHit({ x: 140, y: migrant.position.y }, { x: 210, y: migrant.position.y }, 75);
  manager.clear();
  manager.advance({ rocks: [structuredClone(destination)], players: [], nowFrame: 38 });
  expect(manager.snapshot()).toHaveLength(1);
  expect(manager.snapshot()[0]?.id).toBe(`belt-crawler:${destination.id}:0`);
});

test('destroyed hosts without a reachable landing kill their spiders, while sleeping never causes escape', () => {
  const manager = new BeltCrawlerManager();
  const rock = host();
  const distant = { ...host(), id: 'distant', position: { x: 1000, y: 0 } };
  manager.advance({ rocks: [rock, distant], players: [], nowFrame: 0 });
  manager.advance({ rocks: [distant], players: [], nowFrame: 1 });
  expect(manager.snapshot()).toEqual([]);
  expect(rock.beltCrawlerHealth).toEqual([BELT_CRAWLER.MAX_HEALTH]);
  manager.advance({ rocks: [rock, distant], players: [], nowFrame: 2 });
  manager.escapeDestroyedHost(rock, [distant], 3);
  expect(manager.snapshot()).toEqual([]);
  expect(rock.beltCrawlerHealth).toEqual([0]);
});

test('a moving rock that blocks an escape kills the airborne spider instead of allowing passage', () => {
  const manager = new BeltCrawlerManager();
  const rock = host();
  const destination = { ...host(), id: 'destination', position: { x: 400, y: 0 } };
  manager.advance({ rocks: [rock, destination], players: [], nowFrame: 0 });
  manager.escapeDestroyedHost(rock, [destination], 1);
  const blocker = { ...host(), id: 'blocker', size: 20, position: { x: 170, y: 0 } };
  manager.advance({ rocks: [destination, blocker], players: [], nowFrame: 20 });
  expect(manager.snapshot()).toEqual([]);
  expect(destination.beltCrawlerHealth).toEqual([0]);
});

test('towing the destination beyond escape reach kills the spider without extending its leap', () => {
  const manager = new BeltCrawlerManager();
  const rock = host();
  const destination = { ...host(), id: 'moving-destination', position: { x: 300, y: 0 } };
  manager.advance({ rocks: [rock, destination], players: [], nowFrame: 0 });
  manager.escapeDestroyedHost(rock, [destination], 1);
  expect(manager.snapshot()[0]?.crawler?.phase).toBe('escaping');
  destination.position.x = 1000;
  manager.advance({ rocks: [destination], players: [], nowFrame: 2 });
  expect(manager.snapshot()).toEqual([]);
  expect(destination.beltCrawlerHealth).toEqual([0]);
  manager.clear();
  manager.advance({ rocks: [structuredClone(destination)], players: [], nowFrame: 3 });
  expect(manager.snapshot()).toEqual([]);
});

test('a rock engulfing the entire airborne segment kills the spider and persists its death', () => {
  const manager = new BeltCrawlerManager();
  const rock = { ...host(), size: 30 };
  const destination = { ...host(), id: 'destination', size: 30, position: { x: 200, y: 0 } };
  manager.advance({ rocks: [rock, destination], players: [], nowFrame: 0 });
  manager.escapeDestroyedHost(rock, [destination], 1);
  expect(manager.snapshot()[0]?.crawler?.phase).toBe('escaping');
  const blocker = { ...host(), id: 'engulfing-blocker', size: 150, position: { x: 100, y: 0 } };
  manager.advance({ rocks: [destination, blocker], players: [], nowFrame: 2 });
  expect(manager.snapshot()).toEqual([]);
  expect(destination.beltCrawlerHealth).toEqual([0]);
  manager.clear();
  manager.advance({ rocks: [structuredClone(destination)], players: [], nowFrame: 3 });
  expect(manager.snapshot()).toEqual([]);
});

test('a wounded hunter pursues across living rocks and repeatedly returns without spawning guards or growing tombstones', () => {
  const manager = new BeltCrawlerManager();
  const source = { ...host(), size: 30, beltCrawlerHealth: [50] };
  const middle = { ...host(), id: 'middle', size: 30, position: { x: 240, y: 0 } };
  const last = { ...host(), id: 'last', size: 30, position: { x: 480, y: 0 } };
  const rocks = [source, middle, last];
  const player = pilot({ x: 700, y: 0 });
  const homes = new Set<string>();
  let frame = 0;
  for (let cycle = 0; cycle < 8; cycle++) {
    player.position.x = cycle % 2 === 0 ? 700 : -250;
    for (let step = 0; step < 700; step++, frame++) {
      manager.advance({ rocks, players: [player], nowFrame: frame });
      const bodies = manager.snapshot();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.id).toBe(`belt-crawler:${source.id}:0`);
      expect(bodies[0]?.health).toBe(50);
      homes.add(bodies[0]?.crawler?.hostId ?? 'missing');
    }
    expect(manager.snapshot()[0]?.crawler?.hostId).toBe(cycle % 2 === 0 ? last.id : source.id);
  }
  expect(homes).toEqual(new Set([source.id, middle.id, last.id]));
  expect(rocks.every((rock) => rock.health === 100)).toBe(true);
  expect(rocks.every((rock) => (rock.beltCrawlerIds?.length ?? 0) <= 1)).toBe(true);
  expect(
    rocks.flatMap((rock) => rock.beltCrawlerHealth ?? []).filter((health) => health > 0)
  ).toEqual([50]);
  manager.clear();
  manager.advance({ rocks: structuredClone(rocks), players: [], nowFrame: frame + 1 });
  expect(manager.snapshot()).toHaveLength(1);
  expect(manager.snapshot()[0]).toMatchObject({ health: 50, crawler: { hostId: source.id } });
});

test('a hunter crawls around its host to a departure edge before hopping toward a pilot behind it', () => {
  const manager = new BeltCrawlerManager();
  const source = { ...host(), size: 60 };
  const next = { ...host(), id: 'next', size: 30, position: { x: -240, y: 0 } };
  const player = pilot({ x: -500, y: 0 });
  manager.advance({ rocks: [source, next], players: [player], nowFrame: 0 });
  expect(manager.snapshot()[0]?.crawler?.phase).toBe('crawling');
  let hopped = false;
  for (let frame = 1; frame < 500; frame++) {
    manager.advance({ rocks: [source, next], players: [player], nowFrame: frame });
    const spider = manager.snapshot()[0];
    if (spider?.crawler?.phase === 'escaping') {
      expect(spider.position.x).toBeLessThan(-40);
      hopped = true;
      break;
    }
  }
  expect(hopped).toBe(true);
});

test('the longer anchored lunge strikes a pilot beyond the old bite reach', () => {
  const manager = new BeltCrawlerManager();
  const source = host();
  const player = pilot({ x: 230, y: 0 });
  let strikes = 0;
  for (let frame = 0; frame < 100; frame++) {
    strikes += manager.advance({ rocks: [source], players: [player], nowFrame: frame }).length;
  }
  expect(strikes).toBeGreaterThan(0);
  expect(manager.snapshot()[0]?.crawler?.hostId).toBe(source.id);
});
