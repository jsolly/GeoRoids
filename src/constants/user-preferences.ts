import { getStoredItem } from '../utils/safeStorage';

export const LOCAL_STORAGE_KEYS = {
  soundOn: 'soundOn',
};

/* Preferences from Localstorage */

export function soundIsOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.soundOn) === 'true';
}

// Initialize checkbox state from stored preference (only in browser environment)
if (typeof document !== 'undefined') {
  const defaultSoundPref = document.querySelector('#soundPref') as HTMLInputElement;
  if (defaultSoundPref) {
    defaultSoundPref.checked = soundIsOn();
  }
}
