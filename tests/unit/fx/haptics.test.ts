import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import {
  HAPTICS_UNSUPPORTED_HINT,
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

beforeEach(() => {
  resetSafeStorage();
  resetHapticsForTests();
  installVibrate(undefined);
});

afterEach(() => {
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
});

test('a missing vibration API leaves the Haptics checkbox off and disabled', () => {
  installVibrate(undefined);
  setHaptics(true);
  syncHapticsControl();
  const checkbox = document.querySelector<HTMLInputElement>('#hapticsPref');
  const hint = document.querySelector<HTMLElement>('#hapticsHint');
  expect(hapticsApiAvailable()).toBe(false);
  expect(checkbox?.disabled).toBe(true);
  expect(checkbox?.checked).toBe(false);
  expect(hint?.hidden).toBe(false);
  expect(hint?.textContent).toBe(HAPTICS_UNSUPPORTED_HINT);
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
