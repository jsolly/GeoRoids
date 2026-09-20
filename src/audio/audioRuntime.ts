import type { Howl } from 'howler';
import { musicIsOn, soundIsOn } from '../constants/user-preferences';
import { logger } from '../utils/Logger';

type AudioLibrary = typeof import('howler');
let library: AudioLibrary | undefined;
let _loading: Promise<void> | undefined;
let context: AudioContext | undefined;
let unlockSource: AudioBufferSourceNode | undefined;
let resuming: Promise<void> | undefined;
let suspending: Promise<void> | undefined;
let queuedGestureResume = false;
let needsPlaybackRestart = false;
let musicBedsRegistered = false;
const sfxInitializers = new Set<(audio: AudioLibrary) => void>();
const musicInitializers = new Set<(audio: AudioLibrary) => void>();
const sfxStopHooks = new Set<() => void>();
const musicStopHooks = new Set<() => void>();

function sfxEnabled(): boolean {
  return soundIsOn() && !document.hidden;
}

function musicEnabled(): boolean {
  return musicBedsRegistered && musicIsOn() && !document.hidden;
}

function sessionEnabled(): boolean {
  return sfxEnabled() || musicEnabled();
}

function contextState(): string {
  return context?.state ?? '';
}

function isInterrupted(): boolean {
  return contextState() === 'interrupted';
}

function isAudioDeviceError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.includes('Failed to start the audio device');
}

function report(error: unknown): void {
  logger.error(
    'SOUND',
    'Audio initialization failed',
    error instanceof Error ? error : new Error(String(error))
  );
}

function reportDeferredDeviceStart(error: unknown): void {
  needsPlaybackRestart = true;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  logger.warn('SOUND', 'Audio device start deferred', {
    contextState: contextState(),
    message: text,
  });
}

function handleContextControlError(error: unknown): void {
  if (isAudioDeviceError(error) || isInterrupted()) {
    reportDeferredDeviceStart(error);
    return;
  }
  report(error);
}

function syncState(): void {
  // Howler exposes this runtime state, but @types/howler omits it.
  const howler = library?.Howler;
  if (howler && context && 'state' in howler) {
    howler.state = context.state;
  }
}

function stopSfxSources(): void {
  for (const stop of sfxStopHooks) {
    stop();
  }
}

function stopMusicSources(): void {
  for (const stop of musicStopHooks) {
    stop();
  }
}

function stopSources(): void {
  unlockSource?.stop();
  unlockSource?.disconnect();
  unlockSource = undefined;
  stopSfxSources();
  stopMusicSources();
}

function restartPlayback(): void {
  initializeSfx();
  initializeMusic();
  needsPlaybackRestart = false;
}

function suspend(): void {
  if (
    !context ||
    context.state === 'closed' ||
    context.state === 'suspended' ||
    isInterrupted() ||
    suspending
  ) {
    return;
  }
  suspending = context
    .suspend()
    .catch(handleContextControlError)
    .finally(() => {
      suspending = undefined;
      syncState();
      if (sessionEnabled()) {
        resume();
      }
    });
}

function resume(fromGesture = false): void {
  if (!context || !sessionEnabled() || context.state === 'closed') {
    return;
  }
  if (resuming) {
    if (fromGesture) {
      queuedGestureResume = true;
    }
    return;
  }
  if (!fromGesture && isInterrupted()) {
    needsPlaybackRestart = true;
    return;
  }
  if (context.state === 'running') {
    syncState();
    if (fromGesture || needsPlaybackRestart) {
      restartPlayback();
    }
    return;
  }
  resuming = context
    .resume()
    .catch(handleContextControlError)
    .finally(() => {
      resuming = undefined;
      syncState();
      const retryGesture = queuedGestureResume;
      queuedGestureResume = false;
      if (!sessionEnabled()) {
        suspend();
      } else if (context?.state === 'running') {
        restartPlayback();
      } else if (retryGesture) {
        resume(true);
      }
    });
}

function resumeFromGesture(): void {
  resume(true);
}

function onContextStateChange(): void {
  syncState();
  if (context?.state !== 'running') {
    stopSources();
    needsPlaybackRestart = true;
    if (!sessionEnabled()) {
      suspend();
    }
    return;
  }
  // Looping beds must restart after an interruption; SFX initializers are
  // idempotent and do not replay one-shot cues.
  restartPlayback();
}

function onVisibilityChange(): void {
  if (sessionEnabled()) {
    library?.Howler.mute(false);
    resume();
    initializeSfx();
    initializeMusic();
  } else {
    stopSources();
    library?.Howler.mute(true);
    suspend();
  }
}

function initializeSfx(): void {
  if (!library || !sfxEnabled()) {
    return;
  }
  for (const initialize of sfxInitializers) {
    initialize(library);
  }
}

function initializeMusic(): void {
  if (!library || !musicEnabled()) {
    return;
  }
  for (const initialize of musicInitializers) {
    initialize(library);
  }
}

function contextIsLive(): boolean {
  return sessionEnabled() && context?.state === 'running';
}

/** Music beds register here so SFX-only tests never open a music session. */
export function registerMusicBedAvailability(available: boolean): void {
  musicBedsRegistered = available;
}

/** Called synchronously by the enabled Play/checkbox gesture, never by gameplay. */
export function activateAudio(): void {
  if (!sessionEnabled()) {
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
      document.addEventListener('pointerdown', resumeFromGesture, true);
      document.addEventListener('keydown', resumeFromGesture, true);
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
  resume(true);
  if (library) {
    library.Howler.mute(false);
    initializeSfx();
    initializeMusic();
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
      audio.Howler.mute(!sessionEnabled());
      initializeSfx();
      initializeMusic();
      if (!sessionEnabled()) {
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
  sfxInitializers.add(initialize);
  sfxStopHooks.add(stop);
  if (library && sfxEnabled()) {
    initialize(library);
  }
}

export function registerMusicSound(
  initialize: (audio: AudioLibrary) => void,
  stop: () => void
): void {
  musicInitializers.add(initialize);
  musicStopHooks.add(stop);
  if (library && musicEnabled()) {
    initialize(library);
  }
}

export function registerSoundStopHook(stop: () => void): void {
  sfxStopHooks.add(stop);
}

export function muteAudio(): void {
  stopSources();
  library?.Howler.mute(true);
  suspend();
}

/** Stop cues without tearing down a live music session. */
export function muteSfxKeepSession(): void {
  stopSfxSources();
  if (!sessionEnabled()) {
    muteAudio();
  }
}

/** Stop beds without tearing down a live Sound Effects session. */
export function muteMusicKeepSession(): void {
  stopMusicSources();
  if (!sessionEnabled()) {
    muteAudio();
  }
}

export function getRunningAudioContext(): AudioContext | null {
  return sfxEnabled() && context?.state === 'running' ? context : null;
}

export function canPlayAudio(sound: Howl): boolean {
  // Howler falls back to HTML media after an XHR transport error. Never play
  // that fallback: every audible source must share this context's lifecycle.
  return (
    contextIsLive() &&
    sound.state() === 'loaded' &&
    '_webAudio' in sound &&
    sound._webAudio === true
  );
}
