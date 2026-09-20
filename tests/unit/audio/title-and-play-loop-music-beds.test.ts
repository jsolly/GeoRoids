import type { HowlOptions } from 'howler';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { logger } from '../../../src/utils/Logger';

class FakeHowl {
  static instances: FakeHowl[] = [];
  readonly voices = new Map<number, { volume: number }>();
  private nextId = 0;
  loaded = true;
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
  rate() {
    return this;
  }
  pos() {
    return this;
  }
  unload = vi.fn(() => {
    this.loaded = false;
  });
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
  constructor() {
    super();
    FakeContext.instances.push(this);
  }
  changeState(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
  createGain() {
    return { connect: vi.fn(), gain: { setValueAtTime: vi.fn() } };
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
let setSound: typeof import('../../../src/audio/Sound').setSound;
let Sound: typeof import('../../../src/audio/Sound').Sound;
let loadLibrary = vi.fn();
let globalAudio: { state: string; mute: ReturnType<typeof vi.fn> };
let removeListeners: Array<() => void> = [];

async function settle() {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
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
  ({ Sound, setSound } = await import('../../../src/audio/Sound'));
});

afterEach(() => {
  setMusic(false);
  setSound(false);
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
  setMusicBedCatalogForTests({ menu: [], inGame: [] });
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
  expect(FakeHowl.instances).toHaveLength(2);
  FakeHowl.instances[0]?.options.onloaderror?.(0, 'decode');
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  window.dispatchEvent(new CustomEvent('playViewOn'));
  setMusic(true);
  await settle();
  expect(FakeHowl.instances).toHaveLength(2);
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
