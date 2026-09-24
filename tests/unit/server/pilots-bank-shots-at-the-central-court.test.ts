/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ASTEROID_INTERACTIONS } from '../../../shared/asteroidPhenomena';
import { findCourtImpact } from '../../../shared/ricochetCourt';
import { DAMAGE } from '../../../src/constants';
import { Laser } from '../../../src/entities/laser/Laser';
import { RecordingSocket } from '../../support/recordingSocket';

function courtCrew() {
  const engine = new GameEngine(82);
  const shooter = engine.addPlayer('miner', 'Miner', new RecordingSocket(), { x: 910, y: -860 });
  const target = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 1010, y: -760 },
    'hauler'
  );
  shooter.spawnProtectionTimer = 0;
  target.spawnProtectionTimer = 0;
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  return { engine, shooter, target };
}

test('a pilot banks a shot into another hull without amplifying damage', () => {
  const { engine, shooter, target } = courtCrew();
  const health = target.health;
  const shooterHealth = shooter.health;
  const shot = engine.spawnLaser(shooter.id, { x: 950, y: -860 }, { x: 250, y: 0 });
  assert(shot);
  engine.advanceLasersAndResolveHits();
  expect(shot.bounces).toBe(1);
  expect(shot.energy).toBe(1);
  expect(shot.hasExploded).toBe(true);
  expect(target.health).toBe(health - DAMAGE.LASER_HIT);
  expect(shooter.health).toBe(shooterHealth);
  expect(engine.getServerLasers()).toHaveLength(0);
});

test('a reflector is two-sided and local prediction follows the authoritative bank', () => {
  const { engine, shooter, target } = courtCrew();
  target.position = { x: 800, y: -650 };
  for (const direction of [1, -1]) {
    const position = { x: 1010 - direction * 60, y: -860 };
    const velocity = { x: direction * 100, y: 0 };
    const predicted = new Laser({ ...position }, { ...velocity }, 0, 0);
    const shot = engine.spawnLaser(shooter.id, position, velocity);
    assert(shot);
    predicted.move();
    engine.advanceLasersAndResolveHits();
    expect(shot.bounces).toBe(1);
    expect(shot.energy).toBe(1);
    expect(shot.position.x).toBeCloseTo(1010, 3);
    expect(shot.position.y).toBeCloseTo(-860 + direction * 40, 3);
    expect(predicted.position.x).toBeCloseTo(shot.position.x, 6);
    expect(predicted.position.y).toBeCloseTo(shot.position.y, 6);
    expect(predicted.bounceCount).toBe(shot.bounces);
    expect(Math.hypot(shot.velocity.x, shot.velocity.y)).toBeCloseTo(100, 6);
  }
});

test('the court leaves direct crew shots harmless and protected hulls ignore bank shots', () => {
  const { engine, shooter, target } = courtCrew();
  target.position = { x: 990, y: -860 };
  const health = target.health;
  assert(engine.spawnLaser(shooter.id, { x: 950, y: -860 }, { x: 50, y: 0 }));
  engine.advanceLasersAndResolveHits();
  expect(target.health).toBe(health);
  target.position = { x: 1010, y: -760 };
  target.spawnProtectionTimer = 120;
  assert(engine.spawnLaser(shooter.id, { x: 950, y: -860 }, { x: 250, y: 0 }));
  engine.advanceLasersAndResolveHits();
  expect(target.health).toBe(health);
});

test('a pilot can fly through a reflector without collision damage or displacement', () => {
  const { engine, shooter } = courtCrew();
  const health = shooter.health;
  for (const x of [1000, 1010, 1020]) {
    shooter.position = { x, y: -860 };
    engine.resolveAuthoritativeCombat();
    expect(shooter.position).toEqual({ x, y: -860 });
    expect(shooter.health).toBe(health);
  }
});

test('a court bank can hit its owner, and exhausted shots stop at the reflector', () => {
  const { engine, shooter, target } = courtCrew();
  shooter.position = { x: 1010, y: -760 };
  target.position = { x: 800, y: -650 };
  const health = shooter.health;
  const shot = engine.spawnLaser(shooter.id, { x: 950, y: -860 }, { x: 250, y: 0 });
  assert(shot);
  engine.advanceLasersAndResolveHits();
  expect(shooter.health).toBe(health - DAMAGE.LASER_HIT);
  const exhausted = engine.spawnLaser(shooter.id, { x: 950, y: -860 }, { x: 100, y: 0 });
  assert(exhausted);
  exhausted.bounces = ASTEROID_INTERACTIONS.maxBounces;
  engine.advanceLasersAndResolveHits();
  expect(exhausted.hasExploded).toBe(true);
  expect(exhausted.bounces).toBe(ASTEROID_INTERACTIONS.maxBounces);
});

test('a fast shot hits panel endpoints, but parallel shots and open approaches remain clear', () => {
  expect(findCourtImpact({ x: 910, y: -1000 }, { x: 910, y: -920 })?.point).toEqual({
    x: 910,
    y: -960,
  });
  expect(findCourtImpact({ x: 1010, y: -860 }, { x: 1110, y: -860 })?.distance).toBe(0);
  expect(findCourtImpact({ x: 1010, y: -860 }, { x: 1010, y: -860 })).toBeNull();
  expect(findCourtImpact({ x: 910, y: -960 }, { x: 1110, y: -760 })).toBeNull();
  expect(findCourtImpact({ x: 800, y: -1200 }, { x: 800, y: -650 })).toBeNull();
  expect(findCourtImpact({ x: -800, y: -1000 }, { x: -800, y: 1000 })).toBeNull();
});

test('a fast shot can cross several panels in one tick without losing travel distance', () => {
  const { engine, shooter, target } = courtCrew();
  shooter.position = { x: 0, y: 0 };
  target.position = { x: 0, y: 100 };
  const shot = engine.spawnLaser(shooter.id, { x: 800, y: -900 }, { x: 750, y: 0 });
  assert(shot);
  const predicted = new Laser({ x: 800, y: -900 }, { x: 750, y: 0 }, 0, 0);
  engine.advanceLasersAndResolveHits();
  predicted.move();
  expect(shot.bounces).toBe(2);
  expect(shot.position.x).toBeCloseTo(890, 3);
  expect(shot.position.y).toBeCloseTo(-400, 3);
  expect(shot.energy).toBe(1);
  expect(predicted.bounceCount).toBe(2);
  expect(predicted.position.x).toBeCloseTo(shot.position.x, 6);
  expect(predicted.position.y).toBeCloseTo(shot.position.y, 6);
  expect(predicted.distTraveled).toBeCloseTo(750, 6);
});

test('a rock before a court panel absorbs the shot before it can bank into a pilot', () => {
  const { engine, shooter, target } = courtCrew();
  const health = target.health;
  engine.addAsteroid({
    id: 'court-approach-rock',
    position: { x: 980, y: -860 },
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
  const shot = engine.spawnLaser(shooter.id, { x: 950, y: -860 }, { x: 250, y: 0 });
  assert(shot);
  const hits = engine.advanceLasersAndResolveHits();
  expect(hits.map((hit) => hit.asteroidId)).toEqual(['court-approach-rock']);
  expect(shot.bounces).toBe(0);
  expect(shot.hasExploded).toBe(true);
  expect(target.health).toBe(health);
});
