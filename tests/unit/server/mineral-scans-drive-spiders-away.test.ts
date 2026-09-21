import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { shipOverlapsCompletedSector } from '../../../shared/sectors';
import { SPIDER } from '../../../shared/terrainSpider';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { RecordingSocket } from '../../support/recordingSocket';

const completedSectors = new Set<string>();
function pilot(scanning = false) {
  return { id: 'scout', position: { x: 2200, y: 2200 }, health: 100, exploding: false, scanning };
}

test('switching a scan on at bite distance cancels the bite and drives the spider away until it ends', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const scout = pilot();
  manager.spawnSpider({ x: 2220, y: 2200 });
  manager.advance({ players: [scout], completedSectors, nowFrame: 1 });
  const [bite] = manager.advance({ players: [scout], completedSectors, nowFrame: 2 });
  expect(bite).toBeDefined();
  scout.scanning = true;
  let lastX = 2220;
  for (let frame = 3; frame < 20; frame++) {
    expect(manager.advance({ players: [scout], completedSectors, nowFrame: frame })).toEqual([]);
    const spider = manager.snapshot().spiders[0];
    expect(spider?.position.x).toBeGreaterThan(lastX);
    expect(spider?.targetId).toBeNull();
    lastX = spider?.position.x ?? 0;
  }
  if (bite) {
    expect(manager.isAttackActive(bite)).toBe(false);
  }
  scout.scanning = false;
  manager.advance({ players: [scout], completedSectors, nowFrame: 20 });
  expect(manager.snapshot().spiders[0]?.targetId).toBe(scout.id);
});

test('a scan protects nearby teammates but an out-of-range or dead scanner does not', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const scout = pilot(true);
  const teammate = { ...pilot(), id: 'hauler', position: { x: 2350, y: 2200 } };
  manager.spawnSpider({ x: 2340, y: 2200 });
  manager.advance({ players: [scout, teammate], completedSectors, nowFrame: 1 });
  expect(manager.snapshot().spiders[0]?.targetId).toBeNull();
  expect(manager.snapshot().spiders[0]?.position.x).toBeGreaterThan(2340);
  scout.position.x = 2340 - SHIP_ABILITY.SCAN_RANGE - 100;
  manager.advance({ players: [scout, teammate], completedSectors, nowFrame: 2 });
  expect(manager.snapshot().spiders[0]?.targetId).toBe(teammate.id);
  scout.position = { x: 2200, y: 2200 };
  scout.health = 0;
  manager.advance({ players: [scout, teammate], completedSectors, nowFrame: 3 });
  expect(manager.snapshot().spiders[0]?.targetId).toBe(teammate.id);
});

test('a fleeing spider slides along a completed sector instead of entering it', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const scout = { ...pilot(true), position: { x: 1850, y: 1200 } };
  const completed = new Set(['1,0']);
  manager.spawnSpider({ x: 1960, y: 1200 });
  for (let frame = 1; frame < 20; frame++) {
    expect(
      manager.advance({ players: [scout], completedSectors: completed, nowFrame: frame })
    ).toEqual([]);
    const spider = manager.snapshot().spiders[0];
    expect(spider).toBeDefined();
    if (spider) {
      expect(shipOverlapsCompletedSector(spider.position, SPIDER.HIT_RADIUS, completed)).toBe(
        false
      );
      expect(spider.targetId).toBeNull();
    }
  }
});

test('the real engine repels only with an active Mineral Scan, not a probe or builder equip', () => {
  const engine = new GameEngine(42);
  const actor = engine.addPlayer('scout', 'Scout', new RecordingSocket(), undefined, 'surveyor');
  actor.position = { x: 2200, y: 2200 };
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.spawnTerrainSpider({ x: 2250, y: 2200 });
  expect(engine.useAbility(actor.id)).toBe(true);
  engine.advanceOneFrame();
  expect(engine.getSpiderField().spiders[0]?.position.x).toBeGreaterThan(2250);
  expect(engine.getSpiderField().spiders[0]?.targetId).toBeNull();
  for (const utility of ['survey_probe', 'build_furnace']) {
    engine.setSurveyorUtility(actor.id, utility);
    actor.abilityActiveFrames = 100;
    engine.advanceOneFrame();
    expect(engine.getSpiderField().spiders[0]?.targetId).toBe(actor.id);
  }
});
