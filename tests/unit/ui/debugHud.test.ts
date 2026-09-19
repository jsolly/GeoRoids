import { afterEach, beforeEach, expect, test } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import {
  formatDebugFps,
  formatDebugMotion,
  formatDebugReleases,
  formatDebugRtt,
  formatDebugSnapshot,
  formatDebugWorld,
  resetDebugHudPaintForTests,
  syncDebugHudVisibility,
} from '../../../src/ui/debugHud';
import { applyDebugPreference } from '../../../src/ui/debugIdentity';
import { setPlayView } from '../../../src/ui/uiUtils';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

beforeEach(() => {
  resetSafeStorage();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.debugOn);
  document.body.classList.remove('debug-on', 'in-play');
  setPlayView(false);
  applyDebugPreference(false);
  resetDebugHudPaintForTests();
});

afterEach(() => {
  applyDebugPreference(false);
  setPlayView(false);
  document.body.classList.remove('debug-on', 'in-play');
  resetSafeStorage();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.debugOn);
  resetDebugHudPaintForTests();
});

test('Debug HUD formatters keep the overlay compact and skip missing samples', () => {
  expect(formatDebugFps(undefined)).toBe('—');
  expect(formatDebugFps(60)).toBe('60');
  expect(formatDebugRtt(28)).toBe('28 ms');
  expect(formatDebugSnapshot(1842, 33)).toBe('1842 · 33 ms');
  expect(formatDebugMotion({ mode: 'free', epoch: 4, ack: 3 })).toBe('free · e4 · a3');
  expect(formatDebugWorld(2, 80, 3)).toBe('2p · 80a · 3l');
  expect(formatDebugReleases('a02282efc1d2e3f4a5b6c7d8e9f0aabbccddeeff', 'dev')).toBe(
    'a02282e / dev'
  );
});

test('the Debug HUD is visible only while Debug is on during play', () => {
  const panel = document.querySelector<HTMLElement>('#debug-hud');
  expect(panel).toBeTruthy();
  syncDebugHudVisibility();
  expect(panel?.hidden).toBe(true);

  applyDebugPreference(true);
  syncDebugHudVisibility();
  expect(panel?.hidden).toBe(true);

  setPlayView(true);
  syncDebugHudVisibility();
  expect(panel?.hidden).toBe(false);

  applyDebugPreference(false);
  syncDebugHudVisibility();
  expect(panel?.hidden).toBe(true);
});
