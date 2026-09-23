import type { HowlOptions } from 'howler';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Audio diagnostics use the real logger, but must not open sockets to a running dev server.
vi.mock('../../../src/utils/logForwarder', () => ({
  startClientLogForwarder: vi.fn(),
  forwardLogToServer: vi.fn(),
}));

import { AUDIO } from '../../../src/constants';

class FakeHowl {
  static instances: FakeHowl[] = [];
  readonly voices = new Map<number, { volume: number }>();
  private nextId = 0;
  loaded = true;
  playbackRate = 1;
  _webAudio = true;
  constructor(readonly options: HowlOptions) {
    FakeHowl.instances.push(this);
    queueMicrotask(() => this.options.onload?.(0));
  }
  state() {
    return this.loaded ? 'loaded' : 'loading';
  }
  play = vi.fn(() => {
    const id = ++this.nextId;
    this.voices.set(id, { volume: 1 });
    return id;
  });
  stop = vi.fn((id?: number) => {
    if (id === undefined) {
      for (const voiceId of [...this.voices.keys()]) {
        this.voices.delete(voiceId);
        this.options.onstop?.(voiceId);
      }
      return;
    }
    this.voices.delete(id);
    this.options.onstop?.(id);
  });
  playing(id?: number) {
    return id === undefined ? this.voices.size > 0 : this.voices.has(id);
  }
  volume(value?: number, id?: number) {
    if (typeof value === 'number' && id !== undefined) {
      const voice = this.voices.get(id);
      if (voice) {
        voice.volume = value;
      }
      this.options.onfade?.(id);
      return value;
    }
    if (typeof value === 'number') {
      return this.voices.get(value)?.volume ?? 0;
    }
    return 0;
  }
  fade(_from: number, to: number, _duration: number, id?: number) {
    if (id !== undefined) {
      this.volume(to, id);
    }
    this.options.onfade?.(id ?? 0);
  }
  rate(value?: number) {
    if (typeof value === 'number') {
      this.playbackRate = value;
      return this;
    }
    return this.playbackRate;
  }
  pos() {
    return this;
  }
  unload = vi.fn(() => {
    this.loaded = false;
    this.stop();
  });
  off = vi.fn();
}

class FakeContext extends EventTarget {
  static instances: FakeContext[] = [];
  state = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  resume = vi.fn((): Promise<void> => {
    this.changeState('running');
    return Promise.resolve();
  });
  suspend = vi.fn((): Promise<void> => {
    this.changeState('suspended');
    return Promise.resolve();
  });
  close = vi.fn((): Promise<void> => {
    this.changeState('closed');
    return Promise.resolve();
  });
  constructor() {
    super();
    FakeContext.instances.push(this);
  }
  changeState(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn() } };
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
  }
}

let setMusic: typeof import('../../../src/audio/musicBeds').setMusic;
let setMusicBedCatalogForTests: typeof import('../../../src/audio/musicBeds').setMusicBedCatalogForTests;
let pushMusicThreat: typeof import('../../../src/audio/musicThreat').pushMusicThreat;
let clearMusicThreat: typeof import('../../../src/audio/musicThreat').clearMusicThreat;
let resetMusicThreats: typeof import('../../../src/audio/musicThreat').resetMusicThreats;
let setSound: typeof import('../../../src/audio/Sound').setSound;
let Sound: typeof import('../../../src/audio/Sound').Sound;
let logger: typeof import('../../../src/utils/Logger').logger;
let loadLibrary = vi.fn();
let globalAudio: { state: string; mute: ReturnType<typeof vi.fn> };
let removeListeners: Array<() => void> = [];

async function settle() {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function howlFor(fragment: string): FakeHowl | undefined {
  return FakeHowl.instances.find((howl) =>
    (howl.options.src as string[] | undefined)?.some((src) => src.includes(fragment))
  );
}

async function enterPlay(): Promise<void> {
  document.body.classList.add('in-play');
  window.dispatchEvent(new CustomEvent('playViewOn'));
  await settle();
}

async function leavePlay(): Promise<void> {
  document.body.classList.remove('in-play');
  window.dispatchEvent(new CustomEvent('playViewOff'));
  await settle();
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  FakeHowl.instances = [];
  FakeContext.instances = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const addEventListener = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((...args) => {
    addEventListener(...args);
    removeListeners.push(() => document.removeEventListener(...args));
  });
  const addWindowListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((...args) => {
    addWindowListener(...args);
    removeListeners.push(() => window.removeEventListener(...args));
  });
  globalAudio = { state: 'suspended', mute: vi.fn() };
  loadLibrary = vi.fn(() => ({ Howl: FakeHowl, Howler: globalAudio }));
  vi.doMock('howler', () => loadLibrary());
  ({ setMusic, setMusicBedCatalogForTests } = await import('../../../src/audio/musicBeds'));
  ({ pushMusicThreat, clearMusicThreat, resetMusicThreats } = await import(
    '../../../src/audio/musicThreat'
  ));
  ({ Sound, setSound } = await import('../../../src/audio/Sound'));
  ({ logger } = await import('../../../src/utils/Logger'));
});

afterEach(() => {
  setMusic(false);
  setSound(false);
  resetMusicThreats();
  document.body.classList.remove('in-play');
  for (const remove of removeListeners) {
    remove();
  }
  removeListeners = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('howler');
});

test('missing beds keep the Music checkbox without loading or logging', async () => {
  const errors = vi.spyOn(logger, 'error');
  setMusicBedCatalogForTests({ menu: [], inGame: [], danger: [] });
  setMusic(true);
  await settle();
  expect(loadLibrary).not.toHaveBeenCalled();
  expect(FakeContext.instances).toHaveLength(0);
  expect(FakeHowl.instances).toHaveLength(0);
  expect(errors.mock.calls.some((call) => call[0] === 'SOUND')).toBe(false);
  expect(localStorage.getItem('musicOn')).toBe('true');
});

test('a failed bed load stays silent and does not rebuild Howls', async () => {
  const errors = vi.spyOn(logger, 'error');
  setMusic(true);
  await settle();
  expect(FakeHowl.instances).toHaveLength(3);
  FakeHowl.instances[0]?.options.onloaderror?.(0, 'decode');
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  window.dispatchEvent(new CustomEvent('playViewOn'));
  setMusic(true);
  await settle();
  expect(FakeHowl.instances).toHaveLength(3);
  expect(FakeHowl.instances[0]?.unload).toHaveBeenCalled();
  expect(errors.mock.calls.some((call) => call[0] === 'SOUND')).toBe(false);
});

test('a title gesture loops the Ogg menu bed under Sound Effects off', async () => {
  setSound(false);
  setMusic(true);
  await settle();
  const menu = FakeHowl.instances[0];
  expect(menu?.options).toMatchObject({
    src: ['/music/menu-bed.ogg', '/music/menu-bed.mp3'],
    loop: true,
    html5: false,
    autoplay: false,
  });
  expect(menu?.play).toHaveBeenCalledTimes(1);
  expect(globalAudio.mute).toHaveBeenLastCalledWith(false);
});

test('Enter Game crossfades to the playfield bed and return restores the lobby', async () => {
  setMusic(true);
  await settle();
  expect(FakeHowl.instances[0]?.play).toHaveBeenCalledTimes(1);
  document.body.classList.add('in-play');
  window.dispatchEvent(new CustomEvent('playViewOn'));
  await settle();
  const menu = FakeHowl.instances[0];
  const playfield = FakeHowl.instances[1];
  expect(playfield?.options.src).toEqual(['/music/in-game-bed.ogg', '/music/in-game-bed.mp3']);
  expect(playfield?.play).toHaveBeenCalledTimes(1);
  expect(menu?.stop).toHaveBeenCalled();
  document.body.classList.remove('in-play');
  window.dispatchEvent(new CustomEvent('playViewOff'));
  await settle();
  expect(menu?.play.mock.calls.length).toBeGreaterThan(1);
  expect(playfield?.playing()).toBe(false);
  expect(menu?.playing()).toBe(true);
});

test('Music off stops beds while Sound Effects still play cues', async () => {
  const cue = new Sound('/sounds/laser.m4a', 2, 0.04);
  setSound(true);
  setMusic(true);
  await settle();
  expect(FakeHowl.instances.some((howl) => howl.options.loop === true)).toBe(true);
  setMusic(false);
  await settle();
  for (const howl of FakeHowl.instances.filter((item) => item.options.loop === true)) {
    expect(howl.playing()).toBe(false);
  }
  await cue.play();
  const laser = FakeHowl.instances.find((howl) => howl.options.loop !== true);
  expect(laser?.play).toHaveBeenCalled();
});

test('Sound Effects mute leaves the looping bed running', async () => {
  setMusic(true);
  setSound(true);
  await settle();
  const bed = FakeHowl.instances.find((howl) => howl.options.loop === true);
  expect(bed?.playing()).toBe(true);
  setSound(false);
  await settle();
  expect(bed?.playing()).toBe(true);
  expect(globalAudio.mute).not.toHaveBeenLastCalledWith(true);
  expect(FakeContext.instances[0]?.state).toBe('running');
});

test('turning Music and Sound Effects off suspends the shared session', async () => {
  setMusic(true);
  setSound(true);
  await settle();
  expect(FakeContext.instances[0]?.state).toBe('running');
  setMusic(false);
  await settle();
  expect(FakeContext.instances[0]?.state).toBe('running');
  setSound(false);
  await settle();
  expect(FakeContext.instances[0]?.state).toBe('suspended');
  expect(globalAudio.mute).toHaveBeenLastCalledWith(true);
});

test('an interrupted phone session restarts the bed after a deferred device start', async () => {
  const errors = vi.spyOn(logger, 'error');
  setMusic(true);
  await settle();
  const bed = FakeHowl.instances[0];
  const ctx = FakeContext.instances[0];
  if (!bed || !ctx) {
    throw new Error('Expected music bed and audio context');
  }
  expect(bed.playing()).toBe(true);
  ctx.changeState('interrupted');
  await settle();
  expect(bed.playing()).toBe(false);
  const resumesAfterInterrupt = ctx.resume.mock.calls.length;
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(ctx.resume.mock.calls.length).toBe(resumesAfterInterrupt);

  ctx.changeState('suspended');
  let rejectResume: (error: DOMException) => void = () => {};
  ctx.resume.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectResume = reject;
      })
  );
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  expect(ctx.resume.mock.calls.length).toBe(resumesAfterInterrupt + 2);
  rejectResume(new DOMException('Failed to start the audio device', 'InvalidStateError'));
  await settle();
  expect(ctx.state).toBe('running');
  expect(bed.playing()).toBe(true);
  expect(bed.play.mock.calls.length).toBeGreaterThan(1);
  expect(errors.mock.calls.some((call) => call[0] === 'SOUND')).toBe(false);
});

test('restarting silent audio preserves the danger bed and muted effects without replaying cues', async () => {
  const { restartAudio, readAudioDiagnostics } = await import('../../../src/audio/audioRuntime');
  const { readMusicDiagnostics } = await import('../../../src/audio/musicBeds');
  const cue = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  setMusic(true);
  await enterPlay();
  pushMusicThreat();
  await settle();
  cue.play();
  setSound(false);
  const previousBeds = FakeHowl.instances.filter((howl) => howl.options.loop);
  const previousContext = FakeContext.instances[0];
  const registrations = vi.mocked(document.addEventListener).mock.calls.length;
  expect(readMusicDiagnostics().currentBed).toBe('danger');
  expect(restartAudio()).toBe(true);
  await settle();
  expect(previousContext?.close).toHaveBeenCalledOnce();
  expect(previousBeds.every((bed) => bed.unload.mock.calls.length === 1)).toBe(true);
  expect(vi.mocked(document.addEventListener).mock.calls).toHaveLength(registrations);
  expect(readAudioDiagnostics()).toMatchObject({
    soundEnabled: false,
    musicEnabled: true,
    contextState: 'running',
  });
  expect(readMusicDiagnostics()).toMatchObject({
    currentBed: 'danger',
    beds: [
      { bed: 'menu', playing: false },
      { bed: 'inGame', playing: false },
      { bed: 'danger', playing: true },
    ],
  });
  // Old asynchronous load failures must not unload the replacement bed.
  for (const bed of previousBeds) {
    bed.options.onloaderror?.(0, 'Late failure from discarded audio');
    bed.options.onplayerror?.(0, 'Late failure from discarded audio');
  }
  expect(readMusicDiagnostics().currentBed).toBe('danger');
  expect(FakeHowl.instances.filter((howl) => howl.loaded && !howl.options.loop)).toHaveLength(0);
  setSound(true);
  await settle();
  const freshCue = FakeHowl.instances.find((howl) => howl.loaded && !howl.options.loop);
  expect(freshCue?.play).not.toHaveBeenCalled();
  cue.play();
  expect(freshCue?.play).toHaveBeenCalledOnce();
  clearMusicThreat();
  await settle();
  expect(readMusicDiagnostics().currentBed).toBe('inGame');
});

test('an interrupted hidden session stays silent when the OS auto-resumes', async () => {
  setMusic(true);
  await settle();
  const bed = FakeHowl.instances[0];
  const ctx = FakeContext.instances[0];
  if (!bed || !ctx) {
    throw new Error('Expected music bed and audio context');
  }
  expect(bed.playing()).toBe(true);
  ctx.changeState('interrupted');
  await settle();
  expect(bed.playing()).toBe(false);
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(bed.playing()).toBe(false);

  const playCount = bed.play.mock.calls.length;
  ctx.changeState('running');
  await settle();
  expect(bed.playing()).toBe(false);
  expect(bed.play.mock.calls.length).toBe(playCount);
  expect(ctx.state).toBe('suspended');
  expect(globalAudio.mute).toHaveBeenLastCalledWith(true);
  hidden.mockReturnValue(false);
});

test('hiding the tab stops beds immediately and returning restarts the loop', async () => {
  setMusic(true);
  await settle();
  const bed = FakeHowl.instances[0];
  expect(bed?.playing()).toBe(true);
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(bed?.playing()).toBe(false);
  expect(globalAudio.mute).toHaveBeenLastCalledWith(true);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(globalAudio.mute).toHaveBeenLastCalledWith(false);
  expect(bed?.playing()).toBe(true);
  expect(bed?.play.mock.calls.length).toBeGreaterThan(1);
});

test('a playfield threat crossfades to the danger bed and clear restores Drift', async () => {
  setMusic(true);
  await settle();
  await enterPlay();
  const playfield = howlFor('in-game-bed');
  const danger = howlFor('danger-bed');
  expect(playfield?.playing()).toBe(true);
  expect(danger?.playing()).toBe(false);
  pushMusicThreat();
  await settle();
  expect(danger?.options).toMatchObject({
    src: ['/music/danger-bed.ogg', '/music/danger-bed.mp3'],
    loop: true,
    html5: false,
  });
  expect(danger?.playing()).toBe(true);
  expect(playfield?.playing()).toBe(false);
  clearMusicThreat();
  await settle();
  expect(danger?.playing()).toBe(false);
  expect(playfield?.playing()).toBe(true);
  expect(howlFor('menu-bed')?.playing()).toBe(false);
});

test('nested threats keep the danger bed until the last clear', async () => {
  setMusic(true);
  await settle();
  await enterPlay();
  pushMusicThreat();
  pushMusicThreat();
  await settle();
  const playfield = howlFor('in-game-bed');
  const danger = howlFor('danger-bed');
  expect(danger?.playing()).toBe(true);
  clearMusicThreat();
  await settle();
  expect(danger?.playing()).toBe(true);
  expect(playfield?.playing()).toBe(false);
  clearMusicThreat();
  await settle();
  expect(danger?.playing()).toBe(false);
  expect(playfield?.playing()).toBe(true);
  clearMusicThreat();
  await settle();
  expect(playfield?.playing()).toBe(true);
});

test('Music off silences danger and ignores threat audio until Music returns', async () => {
  const cue = new Sound('/sounds/laser.m4a', 2, 0.04);
  setSound(true);
  setMusic(true);
  await settle();
  await enterPlay();
  pushMusicThreat();
  await settle();
  expect(howlFor('danger-bed')?.playing()).toBe(true);
  setMusic(false);
  await settle();
  expect(howlFor('danger-bed')?.playing()).toBe(false);
  expect(howlFor('in-game-bed')?.playing()).toBe(false);
  pushMusicThreat();
  await settle();
  expect(howlFor('danger-bed')?.playing()).toBe(false);
  await cue.play();
  const laser = FakeHowl.instances.find((howl) => howl.options.loop !== true);
  expect(laser?.play).toHaveBeenCalled();
  setMusic(true);
  await settle();
  expect(howlFor('danger-bed')?.playing()).toBe(true);
});

test('leaving play cancels the threat bed so the lobby cannot inherit it', async () => {
  setMusic(true);
  await settle();
  await enterPlay();
  pushMusicThreat();
  await settle();
  expect(howlFor('danger-bed')?.playing()).toBe(true);
  await leavePlay();
  expect(howlFor('danger-bed')?.playing()).toBe(false);
  expect(howlFor('menu-bed')?.playing()).toBe(true);
  await enterPlay();
  expect(howlFor('danger-bed')?.playing()).toBe(false);
  expect(howlFor('in-game-bed')?.playing()).toBe(true);
});

test('a missing danger bed intensifies Drift until the threat clears', async () => {
  setMusicBedCatalogForTests({
    menu: ['/music/menu-bed.ogg', '/music/menu-bed.mp3'],
    inGame: ['/music/in-game-bed.ogg', '/music/in-game-bed.mp3'],
    danger: [],
  });
  setMusic(true);
  await settle();
  await enterPlay();
  const playfield = howlFor('in-game-bed');
  expect(howlFor('danger-bed')).toBeUndefined();
  expect(playfield?.playing()).toBe(true);
  expect(playfield?.playbackRate).toBe(1);
  pushMusicThreat();
  await settle();
  expect(playfield?.playing()).toBe(true);
  expect(playfield?.playbackRate).toBe(AUDIO.DANGER_FALLBACK_RATE);
  const voice = [...(playfield?.voices.values() ?? [])][0];
  expect(voice?.volume).toBe(AUDIO.DANGER_FALLBACK_VOLUME);
  clearMusicThreat();
  await settle();
  expect(playfield?.playbackRate).toBe(1);
  expect([...(playfield?.voices.values() ?? [])][0]?.volume).toBe(AUDIO.IN_GAME_BED_VOLUME);
});

test('a failed danger load falls back to intensified Drift', async () => {
  setMusic(true);
  await settle();
  await enterPlay();
  const danger = howlFor('danger-bed');
  danger?.options.onloaderror?.(0, 'decode');
  await settle();
  pushMusicThreat();
  await settle();
  expect(danger?.playing()).toBe(false);
  const playfield = howlFor('in-game-bed');
  expect(playfield?.playing()).toBe(true);
  expect(playfield?.playbackRate).toBe(AUDIO.DANGER_FALLBACK_RATE);
});
