/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { DAMAGE } from '../../../shared/constants/gameplay';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function crew() {
  const engine = new GameEngine(83);
  const shooter = engine.addPlayer('miner', 'Miner', new RecordingSocket(), {
    x: WORLD.radius - 1000,
    y: 0,
  });
  const teammate = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  shooter.spawnProtectionTimer = 0;
  teammate.spawnProtectionTimer = 0;
  for (const rock of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(rock.id);
  }
  return { engine, shooter, teammate };
}

test('an unbounced crew shot still travels through a live hull', () => {
  const { engine, shooter, teammate } = crew();
  const health = teammate.health;
  const shot = engine.laserCombat.spawn(shooter.id, { x: -80, y: 0 }, { x: 120, y: 0 });
  assert(shot);
  engine.laserCombat.advance();
  expect(shot.bounces).toBe(0);
  expect(shot.hasExploded).toBe(false);
  expect(teammate.health).toBe(health);
  expect(engine.laserCombat.shots()).toHaveLength(1);
});

test('an already bounced shot damages the first live hull and is consumed', () => {
  const { engine, shooter, teammate } = crew();
  const health = teammate.health;
  const shot = engine.laserCombat.spawn(shooter.id, { x: -80, y: 0 }, { x: 120, y: 0 });
  assert(shot);
  shot.bounces = 1;
  shot.energy = 2;
  engine.laserCombat.advance();
  expect(shot.hasExploded).toBe(true);
  expect(engine.laserCombat.shots()).toEqual([]);
  expect(teammate.health).toBe(health - DAMAGE.LASER_HIT * 2);
  expect(shooter.health).toBe(shooter.maxHealth);
});

test('a wall ricochet can damage the shooter on its returning path', () => {
  const { engine, shooter } = crew();
  shooter.position = { x: WORLD.radius - 80, y: 0 };
  const health = shooter.health;
  const shot = engine.laserCombat.spawn(
    shooter.id,
    { x: WORLD.radius - 10, y: 0 },
    { x: 100, y: 0 }
  );
  assert(shot);
  engine.laserCombat.advance();
  expect(shot.bounces).toBe(1);
  expect(shot.hasExploded).toBe(true);
  expect(shooter.health).toBe(health - DAMAGE.LASER_HIT);
  expect(shooter.deathCause).toBeUndefined();
});

test('a spawn-protected hull does not stop a ricochet', () => {
  const { engine, shooter, teammate } = crew();
  teammate.position = { x: WORLD.radius - 60, y: 0 };
  teammate.spawnProtectionTimer = 12;
  const health = teammate.health;
  const shot = engine.laserCombat.spawn(
    shooter.id,
    { x: WORLD.radius - 10, y: 0 },
    { x: 100, y: 0 }
  );
  assert(shot);
  engine.laserCombat.advance();
  expect(shot.bounces).toBe(1);
  expect(shot.hasExploded).toBe(false);
  expect(teammate.health).toBe(health);
  expect(shot.position.x).toBeCloseTo(WORLD.radius - 90, 3);
});

test('a reflective bounce arms the returning shot against a hull in its path', () => {
  const { engine, shooter, teammate } = crew();
  shooter.position = { x: -500, y: 0 };
  teammate.position = { x: -40, y: 0 };
  const reflector: AsteroidData = {
    id: 'reflector',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 32,
    jaggedness: 0,
    rotation: Math.PI / 4,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
    phenomenon: { kind: 'reflective', clusterId: 'cluster', energy: 0, maxEnergy: 6 },
  };
  engine.asteroidLifecycle.insert(reflector);
  const health = teammate.health;
  const shot = engine.laserCombat.spawn(shooter.id, { x: -50, y: 0 }, { x: 40, y: 0 });
  assert(shot);
  engine.laserCombat.advance();
  expect(shot.bounces).toBe(1);
  expect(shot.hasExploded).toBe(true);
  expect(teammate.health).toBe(health - DAMAGE.LASER_HIT * shot.energy);
  expect(engine.getAsteroid(reflector.id)).toBeDefined();
});
