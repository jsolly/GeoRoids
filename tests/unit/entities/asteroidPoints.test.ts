import { describe, expect, test } from 'vitest';
import { ROID } from '../../../src/constants';
import { pointsForRoidSize } from '../../../src/entities/roid/roidScore';
import { asteroidPointsForRadius } from '../../../src/physics/collision/collisionDetection';

describe('Asteroid Points Calculation', () => {
  test('large asteroids use the collab-aware size bucket', () => {
    expect(pointsForRoidSize(40)).toBe(ROID.POINTS_LARGE);
    expect(pointsForRoidSize(50)).toBe(ROID.POINTS_LARGE);
    expect(pointsForRoidSize(100)).toBe(ROID.POINTS_LARGE);
  });

  test('returns medium-asteroid points for radius >= 20', () => {
    expect(pointsForRoidSize(20)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(25)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(39)).toBe(ROID.POINTS_MEDIUM);
  });

  test('returns small-asteroid points for radius < 20', () => {
    expect(pointsForRoidSize(19)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(10)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(5)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(1)).toBe(ROID.POINTS_SMALL);
  });

  test('handles edge cases', () => {
    expect(pointsForRoidSize(0)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(19.9)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(20.0)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(39.9)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(40.0)).toBe(ROID.POINTS_LARGE);
  });

  test('asteroidPointsForRadius matches the shared size table', () => {
    expect(asteroidPointsForRadius(50)).toBe(pointsForRoidSize(50));
    expect(asteroidPointsForRadius(20)).toBe(pointsForRoidSize(20));
    expect(asteroidPointsForRadius(10)).toBe(pointsForRoidSize(10));
  });
});
