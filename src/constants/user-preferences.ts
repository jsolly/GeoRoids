import { getStoredItem, setStoredItem } from '../utils/safeStorage';

export const LOCAL_STORAGE_KEYS = {
  soundOn: 'soundOn',
  hapticsOn: 'hapticsOn',
  debugOn: 'debugOn',
  debugHudHidden: 'debugHudHidden',
};

/* Preferences from Localstorage */

export function soundIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.soundOn) === 'true';
}

export function debugIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.debugOn) === 'true';
}

export function setDebugPreference(enabled: boolean): void {
  setStoredItem(LOCAL_STORAGE_KEYS.debugOn, String(enabled));
}

// Initialize checkbox state from stored preference (only in browser environment)
if (typeof document !== 'undefined') {
  const defaultSoundPref = document.querySelector('#soundPref') as HTMLInputElement;
  if (defaultSoundPref) {
    defaultSoundPref.checked = soundIsOn();
  }
  const defaultDebugPref = document.querySelector('#debugPref') as HTMLInputElement;
  if (defaultDebugPref) {
    defaultDebugPref.checked = debugIsOn();
  }
}
