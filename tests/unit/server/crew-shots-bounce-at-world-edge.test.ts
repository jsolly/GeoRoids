/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function crew() {
  const engine = new GameEngine(82);
  const shooter = engine.addPlayer('miner', 'Miner', new RecordingSocket(), {
    x: WORLD.radius - 1000,
    y: 0,
  });
  const teammate = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: WORLD.radius - 60, y: 0 },
    'hauler'
  );
  shooter.spawnProtectionTimer = 0;
  teammate.spawnProtectionTimer = 0;
  for (const fieldRock of engine.getAllAsteroids()) {
    engine.removeAsteroid(fieldRock.id);
  }
  return { engine, shooter, teammate };
}

function rock(id: string, x: number): AsteroidData {
  return {
    id,
    position: { x, y: 0 },
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
  };
}

test('a pilot cannot inject an inward laser from beyond the world wall', () => {
  const { engine, shooter } = crew();
  shooter.position = { x: WORLD.radius - 30, y: 0 };
  expect(
    engine.spawnPlayerLaser(shooter.id, { x: WORLD.radius + 1, y: 0 }, { x: -3, y: 0 })
  ).toBeNull();
  expect(engine.getServerLasers()).toEqual([]);
});

test('a muzzle exactly on the wall still fires a reflected shot into the world', () => {
  const { engine, shooter } = crew();
  shooter.position = { x: WORLD.radius - 30, y: 0 };
  const shot = engine.spawnPlayerLaser(shooter.id, { x: WORLD.radius, y: 0 }, { x: 3, y: 0 });
  assert(shot);
  engine.advanceLasersAndResolveHits();
  expect(shot.bounces).toBe(1);
  expect(shot.velocity.x).toBe(-3);
  expect(shot.position.x).toBeLessThan(WORLD.radius);
});

test('a wall ricochet damages the crew hull it meets and is consumed', () => {
  const { engine, shooter, teammate } = crew();
  const beforeShooter = { health: shooter.health, lives: shooter.lives, score: shooter.score };
  const beforeTeammate = { health: teammate.health, lives: teammate.lives, score: teammate.score };
  const shot = engine.spawnLaser(shooter.id, { x: WORLD.radius - 10, y: 0 }, { x: 100, y: 0 });
  assert(shot);
  expect(engine.advanceLasersAndResolveHits()).toEqual([]);
  engine.resolveAuthoritativeCombat();
  expect(shot.bounces).toBe(1);
  expect(shot.hasExploded).toBe(true);
  expect(engine.getServerLasers()).toEqual([]);
  expect(teammate.health).toBe(beforeTeammate.health - DAMAGE.LASER_HIT);
  expect(teammate.lives).toBe(beforeTeammate.lives);
  expect(teammate.score).toBe(beforeTeammate.score);
  expect({ health: shooter.health, lives: shooter.lives, score: shooter.score }).toEqual(
    beforeShooter
  );
});

test('a reflected crew shot mines the asteroid on its returning path exactly once', () => {
  const { engine, shooter, teammate } = crew();
  teammate.position.y = 300;
  const target = rock('returning-path', WORLD.radius - 70);
  engine.addAsteroid(target);
  assert(engine.spawnLaser(shooter.id, { x: WORLD.radius - 10, y: 0 }, { x: 100, y: 0 }));
  const hits = engine.advanceLasersAndResolveHits();
  expect(hits).toHaveLength(1);
  expect(hits[0]?.asteroidId).toBe(target.id);
  expect(engine.getAsteroid(target.id)).toBeUndefined();
  expect(engine.getServerLasers()).toHaveLength(0);
  const score = shooter.score;
  expect(score).toBeGreaterThan(0);
  expect(engine.advanceLasersAndResolveHits()).toEqual([]);
  expect(shooter.score).toBe(score);
});

test('an asteroid before the wall absorbs the shot before any boundary reflection', () => {
  const { engine, shooter } = crew();
  const target = rock('outgoing-path', WORLD.radius - 50);
  engine.addAsteroid(target);
  const shot = engine.spawnLaser(shooter.id, { x: WORLD.radius - 100, y: 0 }, { x: 120, y: 0 });
  assert(shot);
  expect(engine.advanceLasersAndResolveHits()[0]?.asteroidId).toBe(target.id);
  expect(shot.bounces).toBe(0);
});

test.each(['scout', 'hauler'] as const)(
  'a full-health grown %s loses exactly one life on the boundary',
  (kitId) => {
    const { engine, shooter } = crew();
    shooter.kitId = kitId;
    shooter.mass = 500;
    shooter.maxHealth = 400;
    shooter.health = 400;
    shooter.position = { x: WORLD.radius - 1, y: 0 };
    const lives = shooter.lives;
    expect(
      engine.resolveAuthoritativeCombat().find((hit) => hit.targetId === shooter.id)?.isDestroyed
    ).toBe(true);
    expect(shooter.health).toBe(0);
    expect(shooter.lives).toBe(lives - 1);
    expect(shooter.deathCause).toBe('boundary');
    engine.resolveAuthoritativeCombat();
    expect(shooter.lives).toBe(lives - 1);
  }
);
