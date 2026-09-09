import assert from 'node:assert/strict';
import { beforeEach, describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { isBiggestAsteroid } from '../../../src/entities/roid/roidScore';

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

describe('Collaborative asteroid split', () => {
  let asteroidManager: AsteroidManager;

  beforeEach(() => {
    asteroidManager = new AsteroidManager(new RNGService());
  });

  test('two players hit big roid within 1s → split', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-1', size: ROID.SIZE }));

    const first = asteroidManager.registerLaserHit('big-1', 'player-a', 0);
    expect(first.outcome).toBe('tagged');
    expect(first.split).toBe(false);
    expect(first.expiresAt).toBe(ROID.COLLAB_SPLIT_WINDOW_MS);
    expect(asteroidManager.getAsteroidCount()).toBe(1);

    const second = asteroidManager.registerLaserHit('big-1', 'player-b', 999);
    expect(second.outcome).toBe('destroyed');
    expect(second.split).toBe(true);
    expect(second.newAsteroids).toHaveLength(2);
    expect(asteroidManager.getAsteroidCount()).toBe(2);
    for (const fragment of second.newAsteroids) {
      expect(fragment.size).toBeLessThan(ROID.SIZE);
      expect(isBiggestAsteroid(fragment.size)).toBe(false);
    }
  });

  test('player and bot hitting a big roid within 1s also splits', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-bot', size: ROID.SIZE }));

    asteroidManager.registerLaserHit('big-bot', 'human-1', 0);
    const result = asteroidManager.registerLaserHit('big-bot', 'server-bot-1', 400);

    expect(result.split).toBe(true);
    expect(result.newAsteroids).toHaveLength(2);
  });

  test('solo player destroying a big roid does not split', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-solo', size: ROID.SIZE }));

    asteroidManager.registerLaserHit('big-solo', 'player-a', 0);
    const result = asteroidManager.registerLaserHit(
      'big-solo',
      'player-a',
      ROID.COLLAB_HIT_DEDUPE_MS + 1
    );

    expect(result.outcome).toBe('destroyed');
    expect(result.split).toBe(false);
    expect(result.newAsteroids).toHaveLength(0);
    expect(asteroidManager.getAsteroidCount()).toBe(0);
  });

  test('same-shooter echo inside the dedupe window is ignored', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-echo', size: ROID.SIZE }));

    asteroidManager.registerLaserHit('big-echo', 'player-a', 0);
    const echo = asteroidManager.registerLaserHit('big-echo', 'player-a', 40);

    expect(echo.outcome).toBe('ignored');
    expect(asteroidManager.getAsteroid('big-echo')).toBeDefined();
    expect(asteroidManager.getAsteroidCount()).toBe(1);
  });

  test('two players hitting a big roid after the 1s window does not split', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-late', size: ROID.SIZE }));

    asteroidManager.registerLaserHit('big-late', 'player-a', 0);
    const late = asteroidManager.registerLaserHit(
      'big-late',
      'player-b',
      ROID.COLLAB_SPLIT_WINDOW_MS + 1
    );

    expect(late.outcome).toBe('tagged');
    expect(late.split).toBe(false);
    expect(asteroidManager.getAsteroidCount()).toBe(1);
  });

  test('expired solo tag destroys a big roid without splitting', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-expire', size: ROID.SIZE }));

    asteroidManager.registerLaserHit('big-expire', 'player-a', 0);
    const expired = asteroidManager.expireStaleHits(ROID.COLLAB_SPLIT_WINDOW_MS + 1);

    expect(expired).toHaveLength(1);
    expect(expired[0]?.playerId).toBe('player-a');
    expect(asteroidManager.getAsteroidCount()).toBe(0);
    expect(asteroidManager.getAsteroid('big-expire')).toBeUndefined();
  });

  test('medium asteroid never splits', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'medium-1', size: 30 }));

    const result = asteroidManager.registerLaserHit('medium-1', 'player-a', 0);

    expect(result.outcome).toBe('destroyed');
    expect(result.split).toBe(false);
    expect(result.newAsteroids).toHaveLength(0);
  });

  test('small asteroid never splits', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'small-1', size: 12 }));

    const result = asteroidManager.registerLaserHit('small-1', 'player-a', 0);

    expect(result.outcome).toBe('destroyed');
    expect(result.split).toBe(false);
    expect(result.newAsteroids).toHaveLength(0);
  });

  test('ship collision destroys without splitting even on a biggest asteroid', () => {
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-ram', size: ROID.SIZE }));

    const result = asteroidManager.destroyFromCollision('big-ram');

    expect(result.outcome).toBe('destroyed');
    expect(result.split).toBe(false);
    expect(result.newAsteroids).toHaveLength(0);
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

  test('asteroid splitting respects max count limit', () => {
    const maxCount = 200;
    for (let i = 0; i < maxCount - 1; i++) {
      asteroidManager.addAsteroid(makeAsteroid({ id: `filler-${i}`, size: 15 }));
    }
    asteroidManager.addAsteroid(makeAsteroid({ id: 'big-capped', size: ROID.SIZE }));
    expect(asteroidManager.getAsteroidCount()).toBe(maxCount);

    asteroidManager.registerLaserHit('big-capped', 'player-a', 0);
    const result = asteroidManager.registerLaserHit('big-capped', 'player-b', 10);

    expect(result.outcome).toBe('destroyed');
    expect(result.split).toBe(false);
    expect(result.newAsteroids).toHaveLength(0);
    expect(asteroidManager.getAsteroidCount()).toBe(maxCount - 1);
  });
});
