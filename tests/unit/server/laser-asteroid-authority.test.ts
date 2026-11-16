/* @vitest-environment node */
import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ROID } from '../../../shared/constants/gameplay';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function asteroidAt(
  id: string,
  size: number,
  position = { x: 400, y: 300 },
  extras: Partial<AsteroidData> = {}
): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: size,
    maxHealth: size,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    ...extras,
  };
}

function isolateAsteroid(engine: GameEngine, asteroid: AsteroidData): void {
  for (const existing of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(existing.id);
  }
  engine.asteroidLifecycle.insert(asteroid);
}

function mediumAsteroid(id: string, position = { x: 400, y: 300 }): AsteroidData {
  return asteroidAt(id, 25, position);
}

function largeAsteroid(id: string, position = { x: 400, y: 300 }): AsteroidData {
  return asteroidAt(id, 50, position);
}

describe('Server laser↔asteroid authority', () => {
  test('breaks a medium asteroid once and ignores a second apply of the same hit', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    for (const asteroid of engine.getAllAsteroids()) {
      engine.asteroidLifecycle.remove(asteroid.id);
    }
    engine.asteroidLifecycle.insert(mediumAsteroid('roid-once'));

    const first = engine.asteroidMining.apply('roid-once', 'p1');
    const second = engine.asteroidMining.apply('roid-once', 'p1');

    expect(first.applied).toBe(true);
    expect(first.outcome).toBe('destroyed');
    expect(first.points).toBe(ROID.POINTS_MEDIUM);
    expect(first.newAsteroids).toHaveLength(0);
    expect(second.applied).toBe(false);
    expect(second.newAsteroids).toHaveLength(0);
    expect(engine.getPlayer('p1')?.score).toBe(0);
    expect(engine.getLoot().find((drop) => drop.kind === 'points')?.points).toBe(
      ROID.POINTS_MEDIUM
    );
    expect(engine.getAsteroid('roid-once')).toBeUndefined();
    expect(engine.getAsteroidCount()).toBe(0);
  });

  test('large-rock destruction leaves points in space without banking them for contributors', () => {
    const engine = new GameEngine();
    engine.addPlayer('miner-a', 'Miner A', {} as never, { x: 0, y: 0 });
    engine.addPlayer('miner-b', 'Miner B', {} as never, { x: 10, y: 0 });
    engine.addPlayer('scout', 'Scout', {} as never, { x: 20, y: 0 });
    engine.asteroidLifecycle.insert(largeAsteroid('roid-reward-contributors', { x: 400, y: 300 }));
    const target = engine.getAsteroid('roid-reward-contributors');
    assert.ok(target);
    target.surveyedBy = ['scout', 'miner-a', 'scout'];

    const result = engine.asteroidMining.apply(target.id, 'miner-b', 'laser');

    expect(result.outcome).toBe('destroyed');
    expect(engine.getPlayer('miner-a')?.score).toBe(0);
    expect(engine.getPlayer('miner-b')?.score).toBe(0);
    expect(engine.getPlayer('scout')?.score).toBe(0);
  });

  test('server laser tick breaks an overlapping medium asteroid once', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    isolateAsteroid(engine, mediumAsteroid('roid-tick', { x: 100, y: 100 }));

    engine.laserCombat.spawn('p1', { x: 70, y: 100 }, { x: 40, y: 0 });
    const hits = engine.laserCombat.advance();

    expect(hits).toHaveLength(1);
    expect(hits[0]?.applied).toBe(true);
    expect(hits[0]?.asteroidId).toBe('roid-tick');
    expect(engine.getAsteroid('roid-tick')).toBeUndefined();

    const again = engine.laserCombat.advance();
    expect(again).toHaveLength(0);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });

  test('server laser tick destroys a large asteroid immediately', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    isolateAsteroid(engine, largeAsteroid('roid-tag', { x: 100, y: 100 }));

    engine.laserCombat.spawn('p1', { x: 40, y: 100 }, { x: 80, y: 0 });
    const hits = engine.laserCombat.advance();

    expect(hits).toHaveLength(1);
    expect(hits[0]?.outcome).toBe('destroyed');
    expect(engine.getAsteroid('roid-tag')).toBeUndefined();
    expect(engine.getPlayer('p1')?.score).toBe(0);
    expect(engine.laserCombat.shots()).toHaveLength(0);
  });

  test('competing pilot lasers destroy a large mineral once and create one reward', () => {
    const engine = new GameEngine(42);
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addPlayer('p2', 'Two', {} as never, { x: 0, y: 20 });
    isolateAsteroid(
      engine,
      asteroidAt('competing-target', 50, { x: 100, y: 100 }, { material: 'crystal' })
    );
    expect(engine.laserCombat.spawn('p1', { x: 40, y: 100 }, { x: 80, y: 0 })).not.toBeNull();
    expect(engine.laserCombat.spawn('p2', { x: 160, y: 100 }, { x: -80, y: 0 })).not.toBeNull();
    const hits = engine.laserCombat.advance();
    expect(hits.filter((hit) => hit.outcome === 'destroyed')).toHaveLength(1);
    expect(engine.getAsteroid('competing-target')).toBeUndefined();
    expect(engine.getLoot().filter((drop) => drop.kind === 'points')).toHaveLength(1);
    expect(engine.getLoot().find((drop) => drop.kind === 'points')?.points).toBe(ROID.POINTS_LARGE);
  });

  test('two players share the same apply-once helper', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addPlayer('p2', 'Two', {} as never, { x: 40, y: 0 });

    engine.asteroidLifecycle.insert(mediumAsteroid('roid-shared'));
    const firstHit = engine.asteroidMining.apply('roid-shared', 'p2');
    const playerHit = engine.asteroidMining.apply('roid-shared', 'p1');

    expect(firstHit.applied).toBe(true);
    expect(firstHit.points).toBe(ROID.POINTS_MEDIUM);
    expect(playerHit.applied).toBe(false);
    expect(engine.getPlayer('p2')?.score).toBe(0);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });

  test('one flight step resolves newer shots first and leaves one reward per distinct rock', () => {
    const engine = new GameEngine(42);
    try {
      const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
      const firstRock = mediumAsteroid('first-rock', { x: 100, y: 100 });
      const secondRock = mediumAsteroid('second-rock', { x: 300, y: 100 });
      isolateAsteroid(engine, firstRock);
      engine.asteroidLifecycle.insert(secondRock);
      assert.ok(engine.laserCombat.spawn(pilot.id, { x: 70, y: 100 }, { x: 40, y: 0 }));
      assert.ok(engine.laserCombat.spawn(pilot.id, { x: 270, y: 100 }, { x: 40, y: 0 }));

      const hits = engine.laserCombat.advance();
      expect(hits.map((hit) => hit.asteroidId)).toEqual([secondRock.id, firstRock.id]);
      expect(hits.map((hit) => hit.outcome)).toEqual(['destroyed', 'destroyed']);
      expect(engine.laserCombat.shots()).toEqual([]);
      expect(engine.getAsteroid(firstRock.id)).toBeUndefined();
      expect(engine.getAsteroid(secondRock.id)).toBeUndefined();
      const rewards = engine.getLoot().filter((drop) => drop.kind === 'points');
      expect(rewards.map((drop) => drop.points)).toEqual([ROID.POINTS_MEDIUM, ROID.POINTS_MEDIUM]);
      expect(engine.laserCombat.advance()).toEqual([]);
      expect(engine.getLoot().filter((drop) => drop.kind === 'points')).toEqual(rewards);
    } finally {
      engine.stopGameLoop();
    }
  });
});
