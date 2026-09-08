import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { setSound } from '../../../src/audio/Sound';
import { soundIsOn } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  getStoredItem,
  removeStoredItem,
  resetSafeStorage,
  setStoredItem,
} from '../../../src/utils/safeStorage';

const originalLocalStorage = globalThis.localStorage;

function installStorage(storage: Storage): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
}

function throwingStorage(): Storage {
  const blocked = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    get length() {
      return blocked();
    },
    clear: blocked,
    getItem: blocked,
    key: blocked,
    removeItem: blocked,
    setItem: blocked,
  };
}

function installThrowingAccessor(): void {
  const blocked = (): never => {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: blocked,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: blocked,
  });
}

beforeEach(() => {
  resetSafeStorage();
  installStorage(originalLocalStorage);
  originalLocalStorage.clear();
});

afterEach(() => {
  resetSafeStorage();
  installStorage(originalLocalStorage);
  originalLocalStorage.clear();
});

test('reads and writes persist when localStorage is available', () => {
  setStoredItem('highScore', '1200');
  expect(getStoredItem('highScore')).toBe('1200');
  expect(originalLocalStorage.getItem('highScore')).toBe('1200');
  removeStoredItem('highScore');
  expect(getStoredItem('highScore')).toBeNull();
});

test('blocked get/set does not throw and keeps values in memory for the tab', () => {
  installStorage(throwingStorage());
  resetSafeStorage();

  expect(() => setStoredItem('currScore', '50')).not.toThrow();
  expect(() => getStoredItem('currScore')).not.toThrow();
  expect(getStoredItem('currScore')).toBe('50');
});

test('blocked storage reports a bounded warning without exposing keys or values', () => {
  installStorage(throwingStorage());
  resetSafeStorage();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  try {
    setStoredItem('private-session-token', 'secret-value');
    getStoredItem('private-session-token');
    removeStoredItem('private-session-token');

    expect(warning).toHaveBeenCalledTimes(1);
    const output = warning.mock.calls.flat().join(' ');
    expect(output).not.toContain('private-session-token');
    expect(output).not.toContain('secret-value');
    expect(output).toContain('[STORAGE]');
    expect(output).toContain('SecurityError');
  } finally {
    warning.mockRestore();
  }
});

test('accessing localStorage itself throwing is treated as a fresh in-memory session', () => {
  installThrowingAccessor();
  resetSafeStorage();

  expect(getStoredItem('highScore')).toBeNull();
  setStoredItem('highScore', '99');
  expect(getStoredItem('highScore')).toBe('99');
});

test('failed persist still allows a later remove in the same session', () => {
  installStorage(throwingStorage());
  resetSafeStorage();

  setStoredItem('currScore', '7');
  removeStoredItem('currScore');
  expect(getStoredItem('currScore')).toBeNull();
});

test('sound preference read/write does not throw when storage is blocked', () => {
  installStorage(throwingStorage());
  resetSafeStorage();

  expect(() => setSound(true)).not.toThrow();
  expect(soundIsOn()).toBe(true);
  expect(() => setSound(false)).not.toThrow();
  expect(soundIsOn()).toBe(false);
});

test('session score still lives on the player when storage is blocked', () => {
  installStorage(throwingStorage());
  resetSafeStorage();

  const player = new Player({
    id: 'local-player',
    name: 'Pilot',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.score = 0;
  expect(() => {
    player.score = 250;
  }).not.toThrow();
  expect(player.score).toBe(250);
  expect(getStoredItem('highScore')).toBeNull();
});
