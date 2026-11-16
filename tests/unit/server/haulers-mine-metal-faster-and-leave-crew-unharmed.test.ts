import { afterEach, beforeEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ROID } from '../../../shared/constants/gameplay';
import type { AsteroidData } from '../../../shared-types';
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
  engine.asteroidLifecycle.insert(metal('heavy-mining'));
  engine.asteroidLifecycle.insert(metal('light-mining'));
  expect(engine.asteroidMining.hit('heavy-mining', hauler.id).outcome).toBe('damaged');
  expect(engine.getAsteroid('heavy-mining')?.health).toBe(25);
  expect(engine.asteroidMining.hit('heavy-mining', hauler.id).outcome).toBe('destroyed');
  expect(engine.asteroidMining.hit('light-mining', scout.id).outcome).toBe('damaged');
  expect(engine.asteroidMining.hit('light-mining', scout.id).outcome).toBe('damaged');
  expect(engine.asteroidMining.hit('light-mining', scout.id).outcome).toBe('destroyed');
  for (const rock of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(rock.id);
  }
  hauler.spawnProtectionTimer = 0;
  scout.spawnProtectionTimer = 0;
  const health = scout.health;
  engine.laserCombat.spawn(hauler.id, { x: 50, y: 0 }, { x: 80, y: 0 });
  engine.laserCombat.advance();
  expect(scout.health).toBe(health);
  expect(engine.laserCombat.shots()).toHaveLength(1);
});

test.each(['leaves', 'changes to Scout'] as const)(
  'a Hauler laser retains mining strength after its owner %s',
  (transition) => {
    engine.addPlayer(
      'observer',
      'Observer',
      new RecordingSocket(),
      { x: -1000, y: -1000 },
      'scout'
    );
    engine.addPlayer('departing-hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    for (const rock of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(rock.id);
    }
    engine.asteroidLifecycle.insert(metal('in-flight-metal'));
    expect(
      engine.laserCombat.spawn('departing-hauler', { x: 950, y: 1000 }, { x: 80, y: 0 })
    ).not.toBeNull();
    if (transition === 'leaves') {
      engine.removePlayer('departing-hauler');
    } else {
      engine.entityManager.updateEntity('departing-hauler', { kitId: 'scout' });
      expect(engine.getPlayer('departing-hauler')?.kitId).toBe('scout');
    }
    engine.laserCombat.advance();
    expect(engine.getAsteroid('in-flight-metal')?.health).toBe(25);
  }
);

test('an unknown miner uses Scout damage and leaves a surviving deposit unrewarded', () => {
  engine.asteroidLifecycle.insert(metal('unclaimed-metal'));
  const result = engine.asteroidMining.hit('unclaimed-metal', 'absent-miner');
  expect(result.outcome).toBe('damaged');
  expect(engine.getAsteroid('unclaimed-metal')?.health).toBe(50);
  expect(engine.getLoot()).toEqual([]);
});

test.each(['scout', 'hauler'] as const)(
  '%s destroys large ordinary minerals on the first hit',
  (kit) => {
    engine.addPlayer('miner', 'Miner', new RecordingSocket(), { x: 0, y: 0 }, kit);
    for (const material of ['ice', 'crystal'] as const) {
      engine.asteroidLifecycle.insert({
        ...metal(material),
        material,
        size: ROID.LARGE_MIN_SIZE,
        health: 100,
        maxHealth: 100,
      });
      expect(engine.asteroidMining.hit(material, 'miner').outcome).toBe('destroyed');
      expect(engine.getAsteroid(material)).toBeUndefined();
    }
  }
);
