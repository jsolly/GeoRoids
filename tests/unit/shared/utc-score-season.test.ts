import { expect, test } from 'vitest';
import { isScoreSeason, utcScoreSeason } from '../../../shared/world';

test('score seasons are UTC calendar months', () => {
  expect(utcScoreSeason(Date.parse('2026-09-30T23:59:59.000Z'))).toBe('2026-09');
  expect(utcScoreSeason(Date.parse('2026-10-01T00:00:00.000Z'))).toBe('2026-10');
  expect(isScoreSeason('2026-09')).toBe(true);
  expect(isScoreSeason('2026-13')).toBe(false);
  expect(isScoreSeason(undefined)).toBe(false);
});
