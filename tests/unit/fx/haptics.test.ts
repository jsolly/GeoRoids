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

function resetHapticsPreferenceUi(): void {
  localStorage.removeItem(LOCAL_STORAGE_KEYS.hapticsOn);
  const checkbox = document.querySelector<HTMLInputElement>('#hapticsPref');
  const hint = document.querySelector<HTMLElement>('#hapticsHint');
  if (checkbox) {
    checkbox.disabled = false;
    checkbox.checked = false;
    checkbox.setAttribute('aria-disabled', 'false');
    checkbox.removeAttribute('aria-describedby');
  }
  if (hint) {
    hint.hidden = true;
    hint.textContent = '';
  }
}

beforeEach(() => {
  resetSafeStorage();
  resetHapticsForTests();
  resetHapticsPreferenceUi();
  installVibrate(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
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
  const checkbox = document.querySelector<HTMLInputElement>('#hapticsPref');
  const hint = document.querySelector<HTMLElement>('#hapticsHint');
  expect(checkbox?.disabled).toBe(false);
  expect(checkbox?.checked).toBe(true);
  expect(checkbox?.getAttribute('aria-disabled')).toBe('false');
  expect(checkbox?.hasAttribute('aria-describedby')).toBe(false);
  expect(hint?.hidden).toBe(true);
  expect(hint?.textContent).toBe('');
});

test('a missing vibration API leaves Haptics off, focusable, and explained', () => {
  installVibrate(undefined);
  setHaptics(true);
  syncHapticsControl();
  const checkbox = document.querySelector<HTMLInputElement>('#hapticsPref');
  const hint = document.querySelector<HTMLElement>('#hapticsHint');
  expect(hapticsApiAvailable()).toBe(false);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.hapticsOn)).toBeNull();
  expect(checkbox?.disabled).toBe(false);
  expect(checkbox?.checked).toBe(false);
  expect(checkbox?.getAttribute('aria-disabled')).toBe('true');
  expect(checkbox?.getAttribute('aria-describedby')).toBe('hapticsHint');
  expect(hint?.hidden).toBe(false);
  expect(hint?.textContent).toBe(HAPTICS_UNSUPPORTED_HINT);
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
