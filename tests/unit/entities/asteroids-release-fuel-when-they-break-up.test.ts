import { beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { isFuelLoot } from '../../../shared/fuel';
import type { AsteroidData } from '../../../shared-types';
import { FUEL, ROID } from '../../../src/constants';

function makeAsteroid(id: string, size: number): AsteroidData {
  return {
    id,
    position: { x: 400, y: 300 },
    velocity: { x: 1, y: 0 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 50,
    maxHealth: 50,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

describe('asteroids release fuel when they break up', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  test('a biggest-class asteroid drops fuel at the breakup point', () => {
    engine.addAsteroid(makeAsteroid('big-1', ROID.SIZE));

    const result = engine.handleAsteroidHit('big-1', 'nobody', 'collision');

    expect(result.outcome).toBe('destroyed');
    const fuel = engine.getLoot().filter(isFuelLoot);
    expect(fuel).toHaveLength(1);
    expect(fuel[0]?.fuel).toBe(FUEL.DROP_AMOUNT);
    expect(fuel[0]?.position).toEqual({ x: 400, y: 300 });
    expect(engine.getLoot().filter((drop) => drop.kind === 'shard')).toHaveLength(1);
    expect(engine.getGameState().loot).toEqual(engine.getLoot());
  });

  test('a medium asteroid does not drop fuel', () => {
    engine.addAsteroid(makeAsteroid('medium-1', 30));

    engine.handleAsteroidHit('medium-1', 'nobody', 'collision');

    expect(engine.getLoot().some(isFuelLoot)).toBe(false);
  });

  test('a small asteroid does not drop fuel', () => {
    engine.addAsteroid(makeAsteroid('small-1', 12));

    engine.handleAsteroidHit('small-1', 'nobody', 'collision');

    expect(engine.getLoot().some(isFuelLoot)).toBe(false);
    expect(engine.getLoot().some((drop) => drop.kind === 'shard')).toBe(true);
  });
});
