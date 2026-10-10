import assert from 'node:assert/strict';
import { beforeEach, describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';

function makeAsteroid(
  overrides: Partial<AsteroidData> & Pick<AsteroidData, 'id' | 'size'>
): AsteroidData {
  return {
    position: { x: 400, y: 300 },
    velocity: { x: 1, y: 1 },
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 50,
    maxHealth: 50,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    ...overrides,
  };
}

describe('Asteroid mining', () => {
  let asteroidManager: AsteroidManager;
  beforeEach(() => {
    asteroidManager = new AsteroidManager(new RNGService(42));
  });
  test.each(['ice', 'crystal'] as const)(
    '%s breaks on its first hit at every ordinary size',
    (material) => {
      for (const size of [12, 30, 39.9, 40, 50]) {
        const id = `${material}-${size}`;
        asteroidManager.addAsteroid(
          makeAsteroid({ id, size, material, health: 100, maxHealth: 100 })
        );
        const result = asteroidManager.registerLaserHit(id, 'first');
        expect(result.outcome).toBe('destroyed');
        expect(result.newAsteroids).toEqual([]);
        expect(asteroidManager.getAsteroid(id)).toBeUndefined();
        expect(asteroidManager.registerLaserHit(id, 'second').outcome).toBe('missing');
      }
    }
  );
  test('a crowded local field suppresses rubble fragments', () => {
    for (let i = 0; i < ROID.SPLIT_NEARBY_LIMIT - 1; i++) {
      asteroidManager.addAsteroid(makeAsteroid({ id: `filler-${i}`, size: 15 }));
    }
    asteroidManager.addAsteroid(makeAsteroid({ id: 'rubble', size: 50, material: 'rubble' }));
    expect(asteroidManager.registerLaserHit('rubble', 'miner').newAsteroids).toEqual([]);
    expect(asteroidManager.getAsteroidCount()).toBe(ROID.SPLIT_NEARBY_LIMIT - 1);
  });
  test('a depleted field generation cannot be targeted after a fresh field is seeded', () => {
    const first = asteroidManager.createAsteroids(1)[0];
    assert.ok(first);

    asteroidManager.clearAsteroids();
    const second = asteroidManager.createAsteroids(1)[0];
    assert.ok(second);
    expect(new Set([first.id, second.id]).size).toBe(2);

    const delayedOldHit = asteroidManager.destroyFromCollision(first.id);
    expect(delayedOldHit.outcome).toBe('missing');
    expect(asteroidManager.getAsteroid(second.id)).toBeDefined();
  });

  test('separate asteroid managers never reuse a field identity', () => {
    const first = asteroidManager.createAsteroids(1)[0];
    const restartedManager = new AsteroidManager(new RNGService());
    const afterRestart = restartedManager.createAsteroids(1)[0];

    assert.ok(first);
    assert.ok(afterRestart);
    expect(new Set([first.id, afterRestart.id]).size).toBe(2);
  });
});
