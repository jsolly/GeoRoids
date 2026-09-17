import { describe, expect, test } from 'vitest';
import { ROID } from '../../../src/constants';
import { isBiggestAsteroid, pointsForRoidSize } from '../../../src/entities/roid/roidScore';

describe('roid score helpers', () => {
  test('biggest class starts at the collab split size', () => {
    expect(isBiggestAsteroid(ROID.COLLAB_SPLIT_MIN_SIZE)).toBe(true);
    expect(isBiggestAsteroid(ROID.COLLAB_SPLIT_MIN_SIZE - 1)).toBe(false);
  });

  test('points follow size class', () => {
    expect(pointsForRoidSize(50)).toBe(ROID.POINTS_LARGE);
    expect(pointsForRoidSize(25)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(12)).toBe(ROID.POINTS_SMALL);
  });

  test('score buckets change at the medium and collab-split sizes', () => {
    expect(pointsForRoidSize(0)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(19.9)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(20)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(39.9)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(ROID.COLLAB_SPLIT_MIN_SIZE)).toBe(ROID.POINTS_LARGE);
  });
});
