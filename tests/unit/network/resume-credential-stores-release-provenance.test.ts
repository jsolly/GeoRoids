import { afterEach, expect, test } from 'vitest';
import { DEV_RELEASE_ID } from '../../../shared/releaseId';
import {
  clearResumeCredential,
  readStoredResumeProvenance,
  storeResumeCredential,
} from '../../../src/network/services/resumeCredential';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

const TOKEN = 'a'.repeat(64);
const SERVER = 'b'.repeat(40);
const CLIENT = 'c'.repeat(40);

afterEach(() => {
  clearResumeCredential();
  resetSafeStorage();
});

test('a joined resume token stores the releases that issued it and last wrote score', () => {
  storeResumeCredential(TOKEN, 'Bob', {
    credentialReleaseId: SERVER,
    scoreReleaseId: DEV_RELEASE_ID,
    clientReleaseId: CLIENT,
  });

  expect(readStoredResumeProvenance()).toEqual({
    credentialReleaseId: SERVER,
    scoreReleaseId: DEV_RELEASE_ID,
    clientReleaseId: CLIENT,
  });
});

test('malformed stored provenance is ignored instead of blocking resume', () => {
  storeResumeCredential(TOKEN, 'Bob', {
    credentialReleaseId: 'short',
    scoreReleaseId: SERVER,
  });

  expect(readStoredResumeProvenance()).toEqual({
    scoreReleaseId: SERVER,
    clientReleaseId: expect.stringMatching(/^(dev|[a-f0-9]{40})$/),
  });
});

test('clearing the resume credential also drops stored release stamps', () => {
  storeResumeCredential(TOKEN, 'Bob', { credentialReleaseId: SERVER });
  clearResumeCredential();
  expect(readStoredResumeProvenance()).toBeUndefined();
});
