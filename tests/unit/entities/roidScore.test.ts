import { describe, expect, test } from 'vitest';
import { ROID } from '../../../src/constants';
import { pointsForRoidSize } from '../../../src/entities/roid/roidScore';

describe('roid score helpers', () => {
  test('points follow size class', () => {
    expect(pointsForRoidSize(50)).toBe(ROID.POINTS_LARGE);
    expect(pointsForRoidSize(25)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(12)).toBe(ROID.POINTS_SMALL);
  });

  test('score buckets change at the medium and large sizes', () => {
    expect(pointsForRoidSize(0)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(19.9)).toBe(ROID.POINTS_SMALL);
    expect(pointsForRoidSize(20)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(39.9)).toBe(ROID.POINTS_MEDIUM);
    expect(pointsForRoidSize(ROID.COLOSSAL_MIN_SIZE)).toBe(ROID.POINTS_COLOSSAL);
    expect(pointsForRoidSize(ROID.COLOSSAL_SIZE)).toBe(ROID.POINTS_COLOSSAL);
    expect(pointsForRoidSize(ROID.LARGE_MIN_SIZE)).toBe(ROID.POINTS_LARGE);
  });
});
