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
let needsPlaybackRestart = false;
let musicBedsRegistered = false;
let listenersInstalled = false;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockSample: { time: number; observedAt: number } | undefined;
let clockProgress: 'not-observed' | 'advancing' | 'stalled' = 'not-observed';
let contextRestarts = 0;
let lastRestartReason: 'stalled-clock' | null = null;
const resetHooks = new Set<() => void>();
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
  monitorClock();
}

function stopClockMonitor(): void {
  clearInterval(clockTimer);
  clockTimer = undefined;
  clockSample = undefined;
  clockProgress = 'not-observed';
}

function monitorClock(): void {
  if (clockTimer !== undefined || !contextIsLive() || !context) {
    return;
  }
  clockSample = { time: context.currentTime, observedAt: performance.now() };
  clockTimer = setInterval(() => {
    if (!contextIsLive() || !context || !clockSample) {
      stopClockMonitor();
      return;
    }
    const now = performance.now();
    if (context.currentTime > clockSample.time) {
      clockSample = { time: context.currentTime, observedAt: now };
      clockProgress = 'advancing';
    } else if (now - clockSample.observedAt >= 2000 && clockProgress !== 'stalled') {
      clockProgress = 'stalled';
      logger.warn('SOUND', 'Audio clock stalled; next gesture will restart audio', {
        contextState: context.state,
        contextTime: context.currentTime,
      });
    }
  }, 1000);
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
  const target = context;
  suspending = target
    .suspend()
    .catch((error: unknown) => {
      if (context === target) {
        handleContextControlError(error);
      }
    })
    .finally(() => {
      if (context === target) {
        suspending = undefined;
        syncState();
        if (sessionEnabled()) {
          resume();
        }
      }
    });
}

function resume(fromGesture = false): void {
  if (!context || !sessionEnabled() || context.state === 'closed') {
    return;
  }
  // A blocked browser resume can remain pending until another trusted gesture.
  // Retry inside that gesture rather than waiting for the blocked promise.
  if (resuming && !fromGesture) {
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
  const target = context;
  const attempt = target
    .resume()
    .catch((error: unknown) => {
      if (context === target) {
        handleContextControlError(error);
      }
    })
    .finally(() => {
      if (context === target) {
        if (resuming === attempt) {
          resuming = undefined;
        }
        syncState();
        if (!sessionEnabled()) {
          suspend();
        } else if (context.state === 'running') {
          restartPlayback();
        }
      }
    });
  resuming = attempt;
}

function resumeFromGesture(event: Event): void {
  if (clockProgress === 'stalled' && event.isTrusted) {
    rebuildAudio();
    return;
  }
  resume(true);
}

function onContextStateChange(): void {
  syncState();
  if (context?.state !== 'running') {
    stopClockMonitor();
    stopSources();
    needsPlaybackRestart = true;
    if (!sessionEnabled()) {
      suspend();
    }
    return;
  }
  if (!sessionEnabled()) {
    stopSources();
    library?.Howler.mute(true);
    suspend();
    return;
  }
  // Looping beds must restart after an interruption; SFX initializers are
  // idempotent and do not replay one-shot cues.
  restartPlayback();
}

function onVisibilityChange(): void {
  stopClockMonitor();
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

function bindLibraryContext(): void {
  if (!library || !context || library.Howler.ctx === context) {
    return;
  }
  library.Howler.masterGain?.disconnect();
  library.Howler.ctx = context;
  library.Howler.masterGain = context.createGain();
  library.Howler.masterGain.connect(context.destination);
  syncState();
}

function rebuildAudio(): void {
  if (!sessionEnabled() || typeof AudioContext === 'undefined') {
    return;
  }
  const previous = context;
  stopClockMonitor();
  stopSources();
  // Remove Howler listeners before unloading, so discarded beds cannot restart.
  for (const reset of resetHooks) {
    reset();
  }
  previous?.removeEventListener('statechange', onContextStateChange);
  context = undefined;
  resuming = undefined;
  suspending = undefined;
  needsPlaybackRestart = false;
  if (previous && previous.state !== 'closed') {
    void previous.close().catch((error: unknown) => {
      logger.warn('SOUND', 'Previous audio context failed to close', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  contextRestarts++;
  lastRestartReason = 'stalled-clock';
  // Keep creation and resume inside the trusted gesture, without awaiting close.
  activateAudio();
  logger.info('SOUND', 'Audio context restart requested', {
    reason: lastRestartReason,
    contextRestarts,
  });
}

/** Retire Howler's transport as well as its sources before replacing a sound. */
export function disposeAudioSound(sound: Howl): void {
  sound.off();
  sound.unload();
  // Howler 2.2.4 leaves XHRs alive after unload. Its late onerror otherwise
  // deletes the shared URL buffer cache and reloads the discarded Howl as HTML
  // media. Disable that fallback only after unload has cleaned Web Audio nodes.
  if ('_webAudio' in sound) {
    sound._webAudio = false;
  }
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
      if (!listenersInstalled) {
        document.addEventListener('visibilitychange', onVisibilityChange);
        document.addEventListener('pointerdown', resumeFromGesture, true);
        document.addEventListener('touchend', resumeFromGesture, true);
        document.addEventListener('keydown', resumeFromGesture, true);
        listenersInstalled = true;
      }
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
  bindLibraryContext();
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
      bindLibraryContext();
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
  stop: () => void,
  reset: () => void
): void {
  sfxInitializers.add(initialize);
  sfxStopHooks.add(stop);
  resetHooks.add(reset);
  if (library && sfxEnabled()) {
    initialize(library);
  }
}

export function registerMusicSound(
  initialize: (audio: AudioLibrary) => void,
  stop: () => void,
  reset: () => void
): void {
  musicInitializers.add(initialize);
  musicStopHooks.add(stop);
  resetHooks.add(reset);
  if (library && musicEnabled()) {
    initialize(library);
  }
}

export function registerSoundStopHook(stop: () => void): void {
  sfxStopHooks.add(stop);
}

export function muteAudio(): void {
  stopClockMonitor();
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

/** Snapshot only: copying diagnostics never creates or resumes audio. */
export function readAudioDiagnostics() {
  return {
    soundEnabled: soundIsOn(),
    musicEnabled: musicIsOn(),
    contextState: context?.state ?? 'not-created',
    contextTime: context?.currentTime ?? null,
    clockProgress,
    contextRestarts,
    lastRestartReason,
    sampleRate: context?.sampleRate ?? null,
    libraryLoaded: library !== undefined,
    resumePending: resuming !== undefined,
    suspendPending: suspending !== undefined,
    needsPlaybackRestart,
    masterGain: library?.Howler.masterGain?.gain.value ?? null,
  };
}
