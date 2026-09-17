import { expect, test } from 'vitest';
import {
  CLIENT_ID_STORAGE_KEY,
  readOrCreateClientId,
  replaceStoredClientId,
} from '../../../src/network/services/clientIdentity';

const CLIENT_ID_PREFIX_PATTERN = /^client-/u;

test('reuses a stored client id so a tab refresh can rejoin the same ship', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };

  const first = readOrCreateClientId(storage);
  const second = readOrCreateClientId(storage);

  expect(first).toMatch(CLIENT_ID_PREFIX_PATTERN);
  expect(second).toBe(first);
  expect(store.get(CLIENT_ID_STORAGE_KEY)).toBe(first);
});

test('creates a fresh id when storage is unavailable', () => {
  expect(readOrCreateClientId(null)).toMatch(CLIENT_ID_PREFIX_PATTERN);
});

test('replaceStoredClientId mints a new tab id for Start after game over', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };

  const first = readOrCreateClientId(storage);
  const next = replaceStoredClientId(storage);

  expect(next).toMatch(CLIENT_ID_PREFIX_PATTERN);
  expect(next).not.toBe(first);
  expect(readOrCreateClientId(storage)).toBe(next);
});
