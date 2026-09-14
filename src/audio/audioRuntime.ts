import type { Howl } from 'howler';
import { soundIsOn } from '../constants/user-preferences';
import { logger } from '../utils/Logger';

type AudioLibrary = typeof import('howler');
let library: AudioLibrary | undefined;
let _loading: Promise<void> | undefined;
let context: AudioContext | undefined;
let unlockSource: AudioBufferSourceNode | undefined;
let resuming: Promise<void> | undefined;
let suspending: Promise<void> | undefined;
const initializers = new Set<(audio: AudioLibrary) => void>();
const stopHooks = new Set<() => void>();

function enabled(): boolean {
  return soundIsOn() && !document.hidden;
}

function report(error: unknown): void {
  logger.error(
    'SOUND',
    'Audio initialization failed',
    error instanceof Error ? error : new Error(String(error))
  );
}

function syncState(): void {
  // Howler exposes this runtime state, but @types/howler omits it.
  const howler = library?.Howler;
  if (howler && context && 'state' in howler) {
    howler.state = context.state;
  }
}

function stopSources(): void {
  unlockSource?.stop();
  unlockSource?.disconnect();
  unlockSource = undefined;
  for (const stop of stopHooks) {
    stop();
  }
}

function suspend(): void {
  if (!context || context.state === 'closed' || context.state === 'suspended' || suspending) {
    return;
  }
  suspending = context
    .suspend()
    .catch(report)
    .finally(() => {
      suspending = undefined;
      syncState();
      if (enabled()) {
        resume();
      }
    });
}

function resume(): void {
  if (!context || !enabled() || resuming || context.state === 'closed') {
    return;
  }
  if (context.state === 'running') {
    syncState();
    return;
  }
  resuming = context
    .resume()
    .catch(report)
    .finally(() => {
      resuming = undefined;
      syncState();
      if (!enabled()) {
        suspend();
      }
    });
}

function onContextStateChange(): void {
  syncState();
  if (context?.state !== 'running') {
    stopSources();
  }
  // Resume only on a foreground/gesture event. Safari's interrupted state can
  // persist until then; simulation must neither retry it nor retain old cues.
  if (!enabled()) {
    suspend();
  }
}

function onVisibilityChange(): void {
  if (enabled()) {
    resume();
  } else {
    stopSources();
    suspend();
  }
}

function initializeSounds(): void {
  if (!library || !enabled()) {
    return;
  }
  for (const initialize of initializers) {
    initialize(library);
  }
}

/** Called synchronously by the enabled Play/checkbox gesture, never by gameplay. */
export function activateAudio(): void {
  if (!enabled()) {
    return;
  }
  if (!context) {
    if (typeof AudioContext === 'undefined') {
      return;
    }
    try {
      // Creating/resuming before the dynamic import preserves iOS user activation.
      context = new AudioContext();
      context.addEventListener('statechange', onContextStateChange);
      document.addEventListener('visibilitychange', onVisibilityChange);
      document.addEventListener('pointerdown', resume, true);
      document.addEventListener('keydown', resume, true);
      const unlock = context.createBufferSource();
      unlock.buffer = context.createBuffer(1, 1, context.sampleRate);
      unlock.connect(context.destination);
      unlockSource = unlock;
      unlock.onended = () => {
        unlock.disconnect();
        if (unlockSource === unlock) {
          unlockSource = undefined;
        }
      };
      unlock.start();
    } catch (error) {
      report(error);
      return;
    }
  }
  resume();
  if (library) {
    library.Howler.mute(false);
    initializeSounds();
    return;
  }
  _loading ??= import('howler')
    .then((audio) => {
      library = audio;
      // The gesture-created context is also Howler's context. Avoid Howler's
      // HTML-media unlock pool and automatic context replacement on mobile.
      audio.Howler.autoUnlock = false;
      audio.Howler.autoSuspend = false;
      if (!context) {
        return;
      }
      audio.Howler.ctx = context;
      audio.Howler.masterGain = context.createGain();
      audio.Howler.masterGain.connect(context.destination);
      syncState();
      audio.Howler.mute(!enabled());
      initializeSounds();
      if (!enabled()) {
        suspend();
      }
    })
    .catch((error: unknown) => {
      _loading = undefined;
      report(error);
    });
}

export function registerAudioSound(
  initialize: (audio: AudioLibrary) => void,
  stop: () => void
): void {
  initializers.add(initialize);
  stopHooks.add(stop);
  if (library && enabled()) {
    initialize(library);
  }
}

export function registerSoundStopHook(stop: () => void): void {
  stopHooks.add(stop);
}

export function muteAudio(): void {
  stopSources();
  library?.Howler.mute(true);
  suspend();
}

export function getRunningAudioContext(): AudioContext | null {
  return enabled() && context?.state === 'running' ? context : null;
}

export function canPlayAudio(sound: Howl): boolean {
  // Howler falls back to HTML media after an XHR transport error. Never play
  // that fallback: every audible source must share this context's lifecycle.
  return (
    getRunningAudioContext() !== null &&
    sound.state() === 'loaded' &&
    '_webAudio' in sound &&
    sound._webAudio === true
  );
}
