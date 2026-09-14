import { afterEach, beforeEach, expect, test, vi } from 'vitest';

class Source extends EventTarget {
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  frequency = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  playbackRate = { value: 1 };
}
class SynthContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  sources: Source[] = [];
  gains: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  createGain() {
    const gain = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    };
    this.gains.push(gain);
    return gain;
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBiquadFilter() {
    return { connect: vi.fn(), frequency: { value: 0 } };
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createOscillator() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
}
let context: SynthContext;
let stopAll = () => {};
let synthesizeSplitCrack: typeof import('../../../src/audio/splitSound').synthesizeSplitCrack;
let getContext: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  context = new SynthContext();
  getContext = vi.fn(() => context);
  vi.doMock('../../../src/audio/audioRuntime', () => ({
    getRunningAudioContext: getContext,
    registerSoundStopHook: (stop: () => void) => {
      stopAll = stop;
    },
    registerAudioSound: vi.fn(),
  }));
  ({ synthesizeSplitCrack } = await import('../../../src/audio/splitSound'));
});
afterEach(() => {
  stopAll();
  vi.doUnmock('../../../src/audio/audioRuntime');
});

test('simultaneous split synthesis is capped and completion releases one slot', () => {
  for (let index = 0; index < 4; index++) {
    expect(synthesizeSplitCrack(1)).toBe(true);
  }
  expect(synthesizeSplitCrack(1)).toBe(false);
  expect(context.sources).toHaveLength(12);
  context.sources[2]?.dispatchEvent(new Event('ended'));
  expect(synthesizeSplitCrack(1)).toBe(true);
  expect(context.sources).toHaveLength(15);
});

test('mute stops every split oscillator and noise source, and disconnects each master', () => {
  synthesizeSplitCrack(1);
  const initialStops = context.sources.map((source) => source.stop.mock.calls.length);
  stopAll();
  for (const [index, source] of context.sources.entries()) {
    expect(source.stop).toHaveBeenCalledTimes((initialStops[index] ?? 0) + 1);
  }
  expect(context.gains[0]?.disconnect).toHaveBeenCalledTimes(1);
  stopAll();
  expect(context.gains[0]?.disconnect).toHaveBeenCalledTimes(1);
});

test('muted or suspended shared audio allocates no synthesis nodes', () => {
  getContext.mockReturnValue(null);
  expect(synthesizeSplitCrack(1)).toBe(false);
  expect(context.sources).toHaveLength(0);
  expect(context.gains).toHaveLength(0);
});
