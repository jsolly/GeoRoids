import { expect, test } from 'vitest';
import {
  DEV_RELEASE_ID,
  isReleaseId,
  readReleaseId,
  releaseField,
} from '../../../shared/releaseId';

test('release identities are a Git SHA or the local dev marker', () => {
  expect(isReleaseId(DEV_RELEASE_ID)).toBe(true);
  expect(isReleaseId('a'.repeat(40))).toBe(true);
  expect(isReleaseId('A'.repeat(40))).toBe(true);
  expect(isReleaseId('abc1234')).toBe(false);
  expect(isReleaseId('')).toBe(false);
  expect(isReleaseId(undefined)).toBe(false);
});

test('readReleaseId lowercases Git SHAs and ignores malformed values', () => {
  expect(readReleaseId(DEV_RELEASE_ID)).toBe(DEV_RELEASE_ID);
  expect(readReleaseId('B'.repeat(40))).toBe('b'.repeat(40));
  expect(readReleaseId('not-a-release')).toBeUndefined();
});

test('releaseField omits unknown values so optional object spreads stay exact', () => {
  expect(releaseField('scoreReleaseId', undefined)).toEqual({});
  expect(releaseField('scoreReleaseId', DEV_RELEASE_ID)).toEqual({
    scoreReleaseId: DEV_RELEASE_ID,
  });
});
