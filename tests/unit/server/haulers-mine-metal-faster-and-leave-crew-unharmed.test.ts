import { afterEach, beforeEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine;
beforeEach(() => {
  engine = new GameEngine(42);
});
afterEach(() => engine.stopGameLoop());
function metal(id: string): AsteroidData {
  return {
    id,
    position: { x: 1000, y: 1000 },
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 6,
    offsets: [1, 1, 1, 1, 1, 1],
  };
}

test('Hauler breaks metal in two shots while Scout needs three and teammate lasers pass through', () => {
  const hauler = engine.addPlayer(
    'hauler',
    'Hauler',
    new RecordingSocket(),
    { x: 0, y: 0 },
    'hauler'
  );
  const scout = engine.addPlayer(
    'scout',
    'Scout',
    new RecordingSocket(),
    { x: 100, y: 0 },
    'scout'
  );
  engine.addAsteroid(metal('heavy-mining'));
  engine.addAsteroid(metal('light-mining'));
  expect(engine.handleAsteroidHit('heavy-mining', hauler.id).outcome).toBe('damaged');
  expect(engine.getAsteroid('heavy-mining')?.health).toBe(25);
  expect(engine.handleAsteroidHit('heavy-mining', hauler.id).outcome).toBe('destroyed');
  expect(engine.handleAsteroidHit('light-mining', scout.id).outcome).toBe('damaged');
  expect(engine.handleAsteroidHit('light-mining', scout.id).outcome).toBe('damaged');
  expect(engine.handleAsteroidHit('light-mining', scout.id).outcome).toBe('destroyed');
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  hauler.spawnProtectionTimer = 0;
  scout.spawnProtectionTimer = 0;
  const health = scout.health;
  engine.spawnLaser(hauler.id, { x: 50, y: 0 }, { x: 80, y: 0 });
  engine.advanceLasersAndResolveHits();
  expect(scout.health).toBe(health);
  expect(engine.getServerLasers()).toHaveLength(1);
});

test('a Hauler laser retains mining strength after its owner leaves', () => {
  engine.addPlayer('observer', 'Observer', new RecordingSocket(), { x: -1000, y: -1000 }, 'scout');
  engine.addPlayer('departing-hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.addAsteroid(metal('in-flight-metal'));
  expect(
    engine.spawnLaser('departing-hauler', { x: 950, y: 1000 }, { x: 80, y: 0 })
  ).not.toBeNull();
  engine.removePlayer('departing-hauler');
  engine.advanceLasersAndResolveHits();
  expect(engine.getAsteroid('in-flight-metal')?.health).toBe(25);
});

test.each(['scout', 'hauler'] as const)(
  '%s destroys large ordinary minerals on the first hit',
  (kit) => {
    engine.addPlayer('miner', 'Miner', new RecordingSocket(), { x: 0, y: 0 }, kit);
    for (const material of ['ice', 'crystal'] as const) {
      engine.addAsteroid({
        ...metal(material),
        material,
        size: ROID.LARGE_MIN_SIZE,
        health: 100,
        maxHealth: 100,
      });
      expect(engine.handleAsteroidHit(material, 'miner').outcome).toBe('destroyed');
      expect(engine.getAsteroid(material)).toBeUndefined();
    }
  }
);
