import type { HowlOptions } from 'howler';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

class FakeHowl {
  static instances: FakeHowl[] = [];
  readonly voices = new Map<number, { volume: number; rate: number }>();
  private nextId = 0;
  loaded = true;
  _webAudio = true;
  constructor(readonly options: HowlOptions) {
    FakeHowl.instances.push(this);
  }
  state() {
    return this.loaded ? 'loaded' : 'loading';
  }
  play = vi.fn(() => {
    const id = ++this.nextId;
    this.voices.set(id, { volume: 1, rate: 1 });
    return id;
  });
  stop = vi.fn((id: number) => {
    this.voices.delete(id);
    this.options.onstop?.(id);
  });
  volume(value: number, id: number) {
    const voice = this.voices.get(id);
    if (voice) {
      voice.volume = value;
    }
  }
  rate(value: number, id: number) {
    const voice = this.voices.get(id);
    if (voice) {
      voice.rate = value;
    }
  }
  pos = vi.fn();
  end(id: number) {
    if (!this.options.loop) {
      this.voices.delete(id);
    }
    this.options.onend?.(id);
  }
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

let Sound: typeof import('../../../src/audio/Sound').Sound;
let setSound: typeof import('../../../src/audio/Sound').setSound;
let activateAudio: typeof import('../../../src/audio/audioRuntime').activateAudio;
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
function context() {
  const ctx = FakeContext.instances[0];
  if (!ctx) {
    throw new Error('Expected context');
  }
  return ctx;
}

function audioDeviceError(): DOMException {
  return new DOMException('Failed to start the audio device', 'InvalidStateError');
}

function howl() {
  const sound = FakeHowl.instances[0];
  if (!sound) {
    throw new Error('Expected howl');
  }
  return sound;
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
  globalAudio = { state: 'suspended', mute: vi.fn() };
  loadLibrary = vi.fn(() => ({ Howl: FakeHowl, Howler: globalAudio }));
  vi.doMock('howler', () => loadLibrary());
  ({ Sound, setSound } = await import('../../../src/audio/Sound'));
  ({ activateAudio } = await import('../../../src/audio/audioRuntime'));
  ({ logger } = await import('../../../src/utils/Logger'));
});

afterEach(() => {
  setSound(false);
  for (const remove of removeListeners) {
    remove();
  }
  removeListeners = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('howler');
});

test('cold muted construction and simulation allocate no library, context or media', async () => {
  const media = vi.spyOn(window, 'Audio');
  const sound = new Sound('sounds/laser.m4a', 8);
  for (let frame = 0; frame < 60; frame++) {
    await sound.play();
    sound.stop();
    activateAudio();
  }
  expect(loadLibrary).not.toHaveBeenCalled();
  expect(FakeContext.instances).toHaveLength(0);
  expect(FakeHowl.instances).toHaveLength(0);
  expect(media).not.toHaveBeenCalled();
});

test('enabled gesture synchronously creates one context shared with lazy Howler', async () => {
  void new Sound('sounds/laser.m4a', 8);
  setSound(true);
  expect(FakeContext.instances).toHaveLength(1);
  expect(context().resume).toHaveBeenCalledTimes(1);
  await settle();
  activateAudio();
  expect(FakeContext.instances).toHaveLength(1);
  expect(globalAudio).toMatchObject({
    ctx: context(),
    state: 'running',
    autoUnlock: false,
    autoSuspend: false,
  });
  expect(howl().options).toMatchObject({ html5: false, autoplay: false, pool: 8 });
});

test('active voice cap drops overflow and releases capacity when a shot ends', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  await sound.play();
  await sound.play();
  await sound.play();
  expect(howl().play).toHaveBeenCalledTimes(2);
  howl().end(1);
  await sound.play();
  expect(howl().play).toHaveBeenCalledTimes(3);
  expect(howl().voices.size).toBe(2);
});

test('overlapping cues preserve tuning and per-voice volume; melody uses exact intervals', async () => {
  const sound = new Sound('sounds/laser.m4a', 2, 0.1);
  setSound(true);
  await settle();
  await sound.play(1);
  expect(sound.playNote(0.5, 7)).toBe(true);
  expect(howl().voices.get(1)).toEqual({ volume: 0.1, rate: 1 });
  expect(howl().voices.get(2)?.volume).toBe(0.05);
  expect(howl().voices.get(2)?.rate).toBeCloseTo(2 ** (7 / 12));
  expect(sound.playNote(1, 12)).toBe(false);
  setSound(false);
  expect(sound.playNote(1, 4)).toBe(false);
});

test('unloaded and interrupted shots are dropped without replay or hot-loop resumes', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  howl().loaded = false;
  await sound.play();
  howl().loaded = true;
  expect(howl().play).not.toHaveBeenCalled();
  await sound.play();
  context().changeState('interrupted');
  expect(sound.isPlaying()).toBe(false);
  for (let frame = 0; frame < 60; frame++) {
    await sound.play();
  }
  expect(context().resume).toHaveBeenCalledTimes(1);
  expect(howl().play).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event('pointerdown'));
  await settle();
  expect(context().resume).toHaveBeenCalledTimes(2);
  expect(howl().play).toHaveBeenCalledTimes(1);
  await sound.play();
  expect(howl().play).toHaveBeenCalledTimes(2);
});

test('muting before lazy initialization completes prevents sample loads', async () => {
  void new Sound('sounds/laser.m4a', 2);
  setSound(true);
  setSound(false);
  await settle();
  expect(FakeHowl.instances).toHaveLength(0);
  expect(context().state).toBe('suspended');
  expect(globalAudio.mute).toHaveBeenLastCalledWith(true);
});

test('late load completion after mute never replays old cues', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  howl().loaded = false;
  await sound.play();
  setSound(false);
  howl().loaded = true;
  howl().options.onload?.(0);
  await settle();
  expect(howl().play).not.toHaveBeenCalled();
  expect(context().state).toBe('suspended');
});

test('an interrupted tab does not resume until a gesture, and a failed lifecycle resume retries', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  const errors = vi.spyOn(logger, 'error');
  const warnings = vi.spyOn(logger, 'warn');
  setSound(true);
  await settle();
  await sound.play();
  context().changeState('interrupted');
  const resumesAfterInterrupt = context().resume.mock.calls.length;
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(context().resume).toHaveBeenCalledTimes(resumesAfterInterrupt);
  expect(sound.isPlaying()).toBe(false);

  context().changeState('suspended');
  let rejectResume: (error: DOMException) => void = () => {};
  context().resume.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectResume = reject;
      })
  );
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('pointerdown'));
  expect(context().resume).toHaveBeenCalledTimes(resumesAfterInterrupt + 1);
  rejectResume(audioDeviceError());
  await settle();
  expect(context().resume).toHaveBeenCalledTimes(resumesAfterInterrupt + 2);
  expect(context().state).toBe('running');
  await sound.play();
  expect(howl().play).toHaveBeenCalledTimes(2);
  expect(errors.mock.calls.some((call) => call[1] === 'Audio initialization failed')).toBe(false);
  expect(warnings.mock.calls.some((call) => call[1] === 'Audio device start deferred')).toBe(true);
});

test('a pending resume that finishes after mute is suspended again', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  context().changeState('interrupted');
  let finish = () => {};
  context().resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          context().changeState('running');
          resolve();
        };
      })
  );
  activateAudio();
  setSound(false);
  await settle();
  finish();
  await settle();
  expect(context().state).toBe('suspended');
  await sound.play();
  expect(howl().play).not.toHaveBeenCalled();
});

test('hiding the page stops sources and foreground resumes without replaying cues', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  await sound.play();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(sound.isPlaying()).toBe(false);
  expect(context().state).toBe('suspended');
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(context().state).toBe('running');
  expect(howl().play).toHaveBeenCalledTimes(1);
});

test('mute stops every active voice once and repeated muted frames do no native work', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  await sound.play();
  await sound.play();
  setSound(false);
  await settle();
  expect(howl().stop).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem('soundOn')).toBe('false');
  for (let frame = 0; frame < 60; frame++) {
    sound.stop();
    await sound.play();
  }
  expect(howl().stop).toHaveBeenCalledTimes(2);
  expect(context().suspend).toHaveBeenCalledTimes(1);
});

test('a Howler transport fallback never starts HTML media playback', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  howl()._webAudio = false;
  await sound.play();
  expect(howl().play).not.toHaveBeenCalled();
});

test('simultaneous remote shots retain independent directions and local reuse recenters', async () => {
  const sound = new Sound('sounds/laser.m4a', 2);
  setSound(true);
  await settle();
  expect(howl().options).toMatchObject({ pos: [0, 0, -1], panningModel: 'HRTF', rolloffFactor: 0 });
  sound.play(1, { x: -200, y: 100 });
  sound.play(1, { x: 200, y: -100 });
  expect(howl().pos.mock.calls).toEqual([
    [-2, 0, 1, 1],
    [2, 0, -1, 2],
  ]);
  howl().end(1);
  sound.play();
  expect(howl().pos).toHaveBeenLastCalledWith(0, 0, -1, 3);
});
