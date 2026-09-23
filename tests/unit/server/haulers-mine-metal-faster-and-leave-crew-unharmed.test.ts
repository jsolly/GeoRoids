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
  expect(engine.handleAsteroidHit('heavy-mining', hauler.id).outcome).toBe('tagged');
  expect(engine.getAsteroid('heavy-mining')?.health).toBe(25);
  expect(engine.handleAsteroidHit('heavy-mining', hauler.id).outcome).toBe('destroyed');
  expect(engine.handleAsteroidHit('light-mining', scout.id).outcome).toBe('tagged');
  expect(engine.handleAsteroidHit('light-mining', scout.id).outcome).toBe('tagged');
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

test('Hauler improves collaborative HP mining while ordinary one-hit rocks stay one-hit', () => {
  engine.addPlayer('miner', 'Miner', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
  engine.addAsteroid({ ...metal('collab-hp'), isCollabTarget: true, health: 100, maxHealth: 100 });
  expect(engine.handleAsteroidDamage('collab-hp', 'miner').asteroid?.health).toBe(50);
  expect(engine.handleAsteroidDamage('collab-hp', 'miner').destroyed).toBe(true);
  for (const material of ['ice', 'rubble'] as const) {
    engine.addAsteroid({ ...metal(material), material, size: 25 });
    expect(engine.handleAsteroidHit(material, 'miner').outcome).toBe('destroyed');
  }
});

test('Hauler mining still requires different pilots to split the largest ice', () => {
  engine.addPlayer('miner', 'Miner', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
  engine.addPlayer('scout', 'Scout', new RecordingSocket(), { x: 100, y: 0 }, 'scout');
  for (const id of ['solo-ice', 'shared-ice']) {
    engine.addAsteroid({ ...metal(id), material: 'ice', size: ROID.COLLAB_SPLIT_MIN_SIZE });
  }
  expect(engine.handleAsteroidHit('solo-ice', 'miner', 'laser', 1000).outcome).toBe('tagged');
  const solo = engine.handleAsteroidHit(
    'solo-ice',
    'miner',
    'laser',
    1000 + ROID.COLLAB_HIT_DEDUPE_MS + 1
  );
  expect(solo.outcome).toBe('destroyed');
  expect(solo.split).toBe(false);
  expect(engine.handleAsteroidHit('shared-ice', 'miner', 'laser', 2000).outcome).toBe('tagged');
  const shared = engine.handleAsteroidHit('shared-ice', 'scout', 'laser', 2001);
  expect(shared.outcome).toBe('destroyed');
  expect(shared.split).toBe(true);
  expect(shared.newAsteroids.length).toBeGreaterThan(0);
});
