import { getStoredItem, setStoredItem } from '../utils/safeStorage';
import { LOG_LEVEL_NAMES, type LogLevelName } from './index';

export const LOCAL_STORAGE_KEYS = {
  soundOn: 'soundOn',
  musicOn: 'musicOn',
  hapticsOn: 'hapticsOn',
  debugOn: 'debugOn',
  debugHudHidden: 'debugHudHidden',
  debugLogLevel: 'debugLogLevel',
};

/* Preferences from Localstorage */

export function soundIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.soundOn) === 'true';
}

export function musicIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.musicOn) !== 'false';
}

export function debugIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.debugOn) === 'true';
}

export function setDebugPreference(enabled: boolean): void {
  setStoredItem(LOCAL_STORAGE_KEYS.debugOn, String(enabled));
}

/** Log level chosen in Advanced ▸ Debug; null when unset or unrecognized. */
export function storedLogLevel(): LogLevelName | null {
  const stored = getStoredItem(LOCAL_STORAGE_KEYS.debugLogLevel);
  return LOG_LEVEL_NAMES.find((level) => level === stored) ?? null;
}

export function setLogLevelPreference(level: LogLevelName): void {
  setStoredItem(LOCAL_STORAGE_KEYS.debugLogLevel, level);
}

// Initialize checkbox state from stored preference (only in browser environment)
if (typeof document !== 'undefined') {
  const defaultSoundPref = document.querySelector('#soundPref') as HTMLInputElement;
  if (defaultSoundPref) {
    defaultSoundPref.checked = soundIsOn();
  }
  const defaultMusicPref = document.querySelector('#musicPref') as HTMLInputElement;
  if (defaultMusicPref) {
    defaultMusicPref.checked = musicIsOn();
  }
  const defaultDebugPref = document.querySelector('#debugPref') as HTMLInputElement;
  if (defaultDebugPref) {
    defaultDebugPref.checked = debugIsOn();
  }
}
