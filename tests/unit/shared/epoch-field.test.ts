import { expect, test } from 'vitest';
import { epochField, readEpoch } from '../../../shared/epochField';

test('readEpoch keeps finite non-negative milliseconds and drops invalid values', () => {
  expect(readEpoch(0)).toBe(0);
  expect(readEpoch(1_758_000_000_000)).toBe(1_758_000_000_000);
  expect(readEpoch(-1)).toBeUndefined();
  expect(readEpoch(Number.POSITIVE_INFINITY)).toBeUndefined();
  expect(readEpoch(Number.NaN)).toBeUndefined();
  expect(readEpoch('1')).toBeUndefined();
  expect(readEpoch(undefined)).toBeUndefined();
});

test('epochField omits unknown values so optional object spreads stay exact', () => {
  expect(epochField('scoreUpdatedAt', undefined)).toEqual({});
  expect(epochField('scoreUpdatedAt', -3)).toEqual({});
  expect(epochField('scoreUpdatedAt', 42)).toEqual({ scoreUpdatedAt: 42 });
});
