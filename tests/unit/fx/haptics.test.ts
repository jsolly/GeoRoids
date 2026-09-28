import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import {
  hapticsApiAvailable,
  hapticsIsEnabled,
  playHaptic,
  playLocalHaptic,
  resetHapticsForTests,
  setHaptics,
  syncHapticsControl,
} from '../../../src/fx/haptics';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

const originalVibrate = navigator.vibrate;

function installPointer(coarse: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
  }));
}

function installVibrate(impl: ((pattern: VibratePattern) => boolean) | undefined): void {
  if (impl) {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: impl,
      writable: true,
    });
    return;
  }
  // jsdom's Navigator is not extensible enough to delete the key in every
  // environment, so replace it with a non-function when we need "unsupported".
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function resetHapticsPreferenceUi(): void {
  localStorage.removeItem(LOCAL_STORAGE_KEYS.hapticsOn);
  const checkbox = document.querySelector<HTMLInputElement>('#hapticsPref');
  if (checkbox) {
    checkbox.checked = false;
  }
  const row = document.querySelector<HTMLElement>('#hapticsRow');
  if (row) {
    row.hidden = true;
  }
}

beforeEach(() => {
  resetSafeStorage();
  resetHapticsForTests();
  resetHapticsPreferenceUi();
  installVibrate(undefined);
  installPointer(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof originalVibrate === 'function') {
    installVibrate(originalVibrate);
  } else {
    installVibrate(undefined);
  }
});

test('haptics stay off until this browser stores an enabled preference', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  expect(hapticsApiAvailable()).toBe(true);
  expect(hapticsIsEnabled()).toBe(false);
  playHaptic('shot');
  expect(vibrate).not.toHaveBeenCalled();
});

test('enabling haptics stores the preference and plays a preview pulse', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  setHaptics(true);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.hapticsOn)).toBe('true');
  expect(hapticsIsEnabled()).toBe(true);
  expect(vibrate).toHaveBeenCalledWith(24);
  expect(document.querySelector<HTMLElement>('#hapticsRow')?.hidden).toBe(false);
  expect(document.querySelector<HTMLInputElement>('#hapticsPref')?.checked).toBe(true);
});

test('a browser without vibration hides the Haptics toggle and stores nothing', () => {
  installVibrate(undefined);
  setHaptics(true);
  syncHapticsControl();
  expect(hapticsApiAvailable()).toBe(false);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.hapticsOn)).toBeNull();
  expect(document.querySelector<HTMLElement>('#hapticsRow')?.hidden).toBe(true);
});

test('a desktop browser that exposes vibrate without a touch screen hides Haptics', () => {
  installVibrate(vi.fn(() => true));
  installPointer(false);
  syncHapticsControl();
  expect(hapticsApiAvailable()).toBe(false);
  expect(document.querySelector<HTMLElement>('#hapticsRow')?.hidden).toBe(true);
});

test('turning haptics off cancels vibration and unchecks the control', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  setHaptics(true);
  vibrate.mockClear();
  setHaptics(false);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.hapticsOn)).toBe('false');
  expect(vibrate).toHaveBeenCalledWith(0);
  expect(document.querySelector<HTMLInputElement>('#hapticsPref')?.checked).toBe(false);
  playHaptic('shot');
  expect(vibrate).toHaveBeenCalledTimes(1);
});

test('a second shot inside the haptic gap does not buzz again', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  setHaptics(true);
  vibrate.mockClear();
  vi.spyOn(performance, 'now')
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(1020)
    .mockReturnValueOnce(1050);
  playHaptic('shot');
  playHaptic('shot');
  expect(vibrate).toHaveBeenCalledTimes(1);
  playHaptic('shot');
  expect(vibrate).toHaveBeenCalledTimes(2);
});

test('remote-flagged cues never call vibrate even when haptics are on', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  setHaptics(true);
  vibrate.mockClear();
  playLocalHaptic(false, 'boom');
  expect(vibrate).not.toHaveBeenCalled();
  playLocalHaptic(true, 'boom');
  expect(vibrate).toHaveBeenCalled();
});
