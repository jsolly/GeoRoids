import { LOCAL_STORAGE_KEYS } from '../constants/user-preferences';
import { getStoredItem, setStoredItem } from '../utils/safeStorage';

type HapticKind = 'preview' | 'shot' | 'hit' | 'boom' | 'boost' | 'ability' | 'pickup';

export const HAPTICS_UNSUPPORTED_HINT =
  'This browser cannot vibrate. Android Chrome usually can; iPhone cannot.';

const PATTERNS: Record<HapticKind, number | number[]> = {
  preview: 24,
  shot: 12,
  hit: 32,
  boom: [40, 40, 80],
  boost: 20,
  ability: 28,
  pickup: 16,
};

const MIN_GAP_MS: Record<HapticKind, number> = {
  preview: 0,
  shot: 40,
  hit: 50,
  boom: 180,
  boost: 80,
  ability: 80,
  pickup: 40,
};

const lastPlayedAt = new Map<HapticKind, number>();

export function hapticsApiAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function hapticsPreferenceOn(): boolean {
  return getStoredItem(LOCAL_STORAGE_KEYS.hapticsOn) === 'true';
}

export function hapticsIsEnabled(): boolean {
  return hapticsApiAvailable() && hapticsPreferenceOn();
}

export function resetHapticsForTests(): void {
  lastPlayedAt.clear();
}

function vibrateNow(pattern: number | number[]): void {
  if (!hapticsApiAvailable()) {
    return;
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    // Vibration is best-effort; a missing motor or a blocked call must not
    // interrupt flight.
  }
}

export function playHaptic(kind: HapticKind): void {
  if (!hapticsIsEnabled()) {
    return;
  }
  const now = performance.now();
  const previous = lastPlayedAt.get(kind) ?? Number.NEGATIVE_INFINITY;
  if (now - previous < MIN_GAP_MS[kind]) {
    return;
  }
  lastPlayedAt.set(kind, now);
  vibrateNow(PATTERNS[kind]);
}

/** Crew and world FX share sound helpers; only the local ship should buzz. */
export function playLocalHaptic(isLocal: boolean, kind: HapticKind): void {
  if (isLocal) {
    playHaptic(kind);
  }
}

export function setHaptics(enabled: boolean): void {
  setStoredItem(LOCAL_STORAGE_KEYS.hapticsOn, String(enabled));
  if (!enabled) {
    vibrateNow(0);
    syncHapticsControl();
    return;
  }
  if (hapticsApiAvailable()) {
    vibrateNow(PATTERNS.preview);
  }
  syncHapticsControl();
}

export function syncHapticsControl(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const checkbox = document.querySelector<HTMLInputElement>('#hapticsPref');
  const hint = document.querySelector<HTMLElement>('#hapticsHint');
  if (!checkbox) {
    return;
  }
  const supported = hapticsApiAvailable();
  checkbox.disabled = !supported;
  checkbox.checked = supported && hapticsPreferenceOn();
  checkbox.setAttribute('aria-disabled', supported ? 'false' : 'true');
  if (hint) {
    hint.hidden = supported;
    hint.textContent = supported ? '' : HAPTICS_UNSUPPORTED_HINT;
  }
}
