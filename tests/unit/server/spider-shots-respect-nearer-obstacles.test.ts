/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AppliedAsteroidHit } from '../../../server/core/types';
import { DAMAGE } from '../../../shared/constants/gameplay';
import { SPIDER } from '../../../shared/terrainSpider';
import { asteroidRow } from '../../support/asteroid-row';
import { RecordingSocket } from '../../support/recordingSocket';
import { attachTowForScenario } from '../../support/tool-flight';

test('a nearer asteroid takes the shot before a spider, and an unobstructed shot damages the spider', () => {
  const engine = new GameEngine(81);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 2800, y: 3000 });
  engine.prepareDiagnosticWorld('traversal');
  for (const rock of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(rock.id);
  }
  engine.parkSatellitePickups();
  const spider = engine.spawnTerrainSpider({ x: 3000, y: 3000 });
  assert(spider);
  engine.asteroidLifecycle.insert({
    id: 'obstacle',
    position: { x: 2940, y: 3000 },
    velocity: { x: 0, y: 0 },
    size: 10,
    health: 10,
    maxHealth: 10,
    material: 'ice',
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  });
  assert(engine.spawnLaser(pilot.id, { x: 2900, y: 3000 }, { x: 200, y: 0 }));
  const hits = engine.advanceLasersAndResolveHits();
  expect(hits.map((hit) => hit.asteroidId)).toEqual(['obstacle']);
  expect(engine.getSpiderField().spiders.find((row) => row.id === spider.id)?.position).toEqual(
    spider.position
  );
  const weakened = engine.spawnLaser(pilot.id, { x: 2955, y: 3000 }, { x: 100, y: 0 });
  assert(weakened);
  weakened.energy = 0.5;
  engine.advanceLasersAndResolveHits();
  const damaged = engine.getSpiderField().spiders.find((row) => row.id === spider.id);
  expect(damaged?.position).toEqual(spider.position);
  expect(damaged?.health).toBe(SPIDER.MAX_HEALTH - DAMAGE.LASER_HIT * 0.5);
  expect(engine.getServerLasers()).toHaveLength(0);
  assert(engine.spawnLaser(pilot.id, { x: 2955, y: 3000 }, { x: 100, y: 0 }));
  engine.advanceLasersAndResolveHits();
  expect(engine.getSpiderField().spiders.some((row) => row.id === spider.id)).toBe(false);
});

test('killing the spider before combat resolves cancels the pending bite', () => {
  const engine = new GameEngine(81);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
  engine.prepareDiagnosticWorld('traversal');
  for (const rock of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(rock.id);
  }
  engine.parkSatellitePickups();
  const spider = engine.spawnTerrainSpider({ x: 2200, y: 2200 });
  assert(spider);
  pilot.position = { ...spider.position };
  pilot.spawnProtectionTimer = 0;
  engine.advanceCombatFrame();
  engine.advanceCombatFrame();
  const health = pilot.health;
  assert(engine.spawnLaser(pilot.id, { ...spider.position }, { x: 10, y: 0 }));
  engine.advanceLasersAndResolveHits();
  expect(engine.getSpiderField().spiders.some((row) => row.id === spider.id)).toBe(false);
  engine.contactCombat.advance();
  expect(pilot.health).toBe(health);
});

test.each(
  (['spawn protection', 'overlay hold'] as const).flatMap((protection) =>
    [1, 50, 100].map((health) => ({ protection, health }))
  )
)(
  '$protection blocks a bite and one later bite kills a pilot with $health health',
  ({ protection, health }) => {
    const engine = new GameEngine(81);
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.prepareDiagnosticWorld('traversal');
    for (const rock of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    engine.parkSatellitePickups();
    const spider = engine.spawnTerrainSpider({ x: 2200, y: 2200 });
    assert(spider);
    pilot.position = { ...spider.position };
    pilot.spawnProtectionTimer = protection === 'spawn protection' ? 600 : 0;
    pilot.overlayHold = protection === 'overlay hold';
    engine.advanceCombatFrame();
    engine.advanceCombatFrame();
    engine.contactCombat.advance();
    expect(pilot.health).toBe(pilot.maxHealth);
    pilot.overlayHold = false;
    pilot.spawnProtectionTimer = 0;
    pilot.health = health;
    pilot.healthRegenTimer = 1000;
    for (let frame = 0; frame <= SPIDER.BITE_COOLDOWN_FRAMES && pilot.health === health; frame++) {
      engine.advanceCombatFrame();
      engine.contactCombat.advance();
    }
    expect(pilot.health).toBe(0);
    expect(pilot.exploding).toBe(true);
    expect(pilot.deathCause).toBe('spider');
  }
);

test('a tow feedback laser kill cancels a queued bite before contact consumes it', () => {
  const engine = new GameEngine(81);
  try {
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.prepareDiagnosticWorld('traversal');
    for (const rock of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    engine.parkSatellitePickups();
    const spider = engine.spawnTerrainSpider({ x: 2200, y: 2200 });
    assert(spider);
    pilot.position = { ...spider.position };
    pilot.spawnProtectionTimer = 0;
    const hauler = engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 1000, y: 1000 },
      'hauler'
    );
    hauler.spawnProtectionTimer = 0;
    const cargo = asteroidRow({ x: 1080, y: 1000 }, 25, 'bite-cancel-cargo');
    const other = asteroidRow({ x: 1105, y: 1000 }, 25, 'bite-cancel-other');
    engine.asteroidLifecycle.insert(cargo);
    engine.asteroidLifecycle.insert(other);
    attachTowForScenario(engine, hauler.id, cargo.id);
    engine.advanceCombatFrame();
    engine.advanceCombatFrame();
    cargo.position = { x: 1080, y: 1000 };
    other.position = { x: 1105, y: 1000 };
    engine.asteroidLifecycle.insert(cargo);
    engine.asteroidLifecycle.insert(other);
    const health = pilot.health;
    const feedback: AppliedAsteroidHit[] = [];
    engine.asteroidHitFeedback.setListener((hits) => {
      expect(hits.map((hit) => [hit.asteroidId, hit.playerId])).toEqual([
        [cargo.id, hauler.id],
        [other.id, hauler.id],
      ]);
      expect(engine.getAsteroid(cargo.id)).toBeUndefined();
      expect(engine.getAsteroid(other.id)).toBeUndefined();
      expect(engine.getSpiderField().spiders.some((row) => row.id === spider.id)).toBe(true);
      feedback.push(...hits);
      assert(engine.spawnLaser(pilot.id, { ...spider.position }, { x: 10, y: 0 }));
      engine.advanceLasersAndResolveHits();
      expect(engine.getSpiderField().spiders.some((row) => row.id === spider.id)).toBe(false);
    });

    expect(engine.contactCombat.advance()).toEqual([]);
    expect(feedback.map((hit) => hit.asteroidId)).toEqual([cargo.id, other.id]);
    expect(pilot.health).toBe(health);
    expect(pilot.exploding).toBe(false);
  } finally {
    engine.stopGameLoop();
  }
});
