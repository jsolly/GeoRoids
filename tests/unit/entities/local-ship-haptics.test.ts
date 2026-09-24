import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Ship } from '../../../src/entities/ship/Ship';
import { resetHapticsForTests, setHaptics } from '../../../src/fx/haptics';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

const originalVibrate = navigator.vibrate;

function installVibrate(impl: (pattern: VibratePattern) => boolean): void {
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: impl,
    writable: true,
  });
}

beforeEach(() => {
  resetSafeStorage();
  resetHapticsForTests();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.hapticsOn);
});

afterEach(() => {
  if (typeof originalVibrate === 'function') {
    installVibrate(originalVibrate);
  }
});

test('a local shot, boost, and explode buzz this device when Haptics is on', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  setHaptics(true);
  vibrate.mockClear();

  const ship = new Ship({ isLocalPlayer: true });
  ship.fireLaser();
  expect(vibrate).toHaveBeenCalled();
  vibrate.mockClear();

  expect(ship.toggleBoost()).toBe(true);
  expect(vibrate).toHaveBeenCalled();
  vibrate.mockClear();

  ship.explode('asteroid');
  expect(vibrate).toHaveBeenCalled();
});

test('a remote explode does not vibrate this device', () => {
  const vibrate = vi.fn(() => true);
  installVibrate(vibrate);
  setHaptics(true);
  vibrate.mockClear();

  const ship = new Ship({ isLocalPlayer: false });
  ship.fireLaser();
  ship.explode('asteroid');
  expect(ship.exploding).toBe(true);
  expect(vibrate).not.toHaveBeenCalled();
});
