import { getStoredItem } from '../utils/safeStorage';
import { LOG_LEVEL_NAMES, type LogLevelName } from './index';

export const LOCAL_STORAGE_KEYS = {
  soundOn: 'soundOn',
  musicOn: 'musicOn',
  hapticsOn: 'hapticsOn',
  debugHudHidden: 'debugHudHidden',
};

/* Preferences from Localstorage */

export function soundIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.soundOn) === 'true';
}

export function musicIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.musicOn) !== 'false';
}

/** Diagnostics are scoped to the debug route, never remembered on the player page. */
export function debugIsOn(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.location.pathname === '/debug' || window.location.pathname === '/debug/')
  );
}

export function clientLogLevel(): LogLevelName {
  if (!debugIsOn()) {
    return 'info';
  }
  const level = new URLSearchParams(window.location.search).get('log-level');
  return LOG_LEVEL_NAMES.find((name) => name === level && name !== 'error') ?? 'info';
}
