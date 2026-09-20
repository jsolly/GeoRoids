import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const parameter = () => ({
  value: 0,
  setValueAtTime: vi.fn(),
  setTargetAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
});
class Tone {
  type = 'sine';
  frequency = parameter();
  detune = parameter();
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}
class OrbitContext {
  currentTime = 1;
  destination = {};
  tones: Tone[] = [];
  gains: ReturnType<typeof parameter>[] = [];
  pan = { positionX: parameter(), positionZ: parameter(), connect: vi.fn(), disconnect: vi.fn() };
  createOscillator() {
    const tone = new Tone();
    this.tones.push(tone);
    return tone;
  }
  createGain() {
    const gain = parameter();
    this.gains.push(gain);
    return { gain, connect: vi.fn(), disconnect: vi.fn() };
  }
  createPanner() {
    return this.pan;
  }
}
let context: OrbitContext;
let getContext: ReturnType<typeof vi.fn>;
let stopHook = () => {};
let sync: typeof import('../../../src/audio/satelliteOrbitSound').syncSatelliteOrbit;
let stop: typeof import('../../../src/audio/satelliteOrbitSound').stopSatelliteOrbit;

beforeEach(async () => {
  vi.resetModules();
  context = new OrbitContext();
  getContext = vi.fn(() => context);
  vi.doMock('../../../src/audio/audioRuntime', () => ({
    getRunningAudioContext: getContext,
    registerSoundStopHook: (hook: () => void) => {
      stopHook = hook;
    },
  }));
  ({ syncSatelliteOrbit: sync, stopSatelliteOrbit: stop } = await import(
    '../../../src/audio/satelliteOrbitSound'
  ));
});
afterEach(() => {
  stop();
  vi.doUnmock('../../../src/audio/audioRuntime');
});

test('one orbit voice follows successive phase updates without allocating another oscillator', () => {
  sync({ id: 'satellite', angle: 0 });
  expect(context.tones).toHaveLength(2);
  expect(context.pan.positionX.setTargetAtTime).toHaveBeenLastCalledWith(1, 1, 0.08);
  for (let frame = 0; frame < 300; frame++) {
    sync({ id: 'satellite', angle: frame / 30 });
  }
  expect(context.tones).toHaveLength(2);
  sync({ id: 'satellite', angle: Math.PI / 2 });
  expect(context.tones[0]?.detune.setTargetAtTime).toHaveBeenLastCalledWith(18, 1, 0.08);
  sync({ id: 'satellite', angle: Math.PI });
  expect(context.pan.positionX.setTargetAtTime).toHaveBeenLastCalledWith(-1, 1, 0.08);
  sync(undefined);
  for (const tone of context.tones) {
    expect(tone.stop).toHaveBeenCalledTimes(1);
    expect(tone.disconnect).toHaveBeenCalledTimes(1);
  }
  stop();
  expect(context.tones[0]?.stop).toHaveBeenCalledTimes(1);
});

test('mute or hidden-tab lifecycle stops the orbit and unavailable audio cannot recreate it', () => {
  sync({ id: 'first', angle: 0 });
  stopHook();
  expect(context.tones.every((tone) => tone.stop.mock.calls.length === 1)).toBe(true);
  getContext.mockReturnValue(null);
  for (let frame = 0; frame < 300; frame++) {
    sync({ id: 'first', angle: frame / 30 });
  }
  expect(context.tones).toHaveLength(2);
  getContext.mockReturnValue(context);
  sync({ id: 'second', angle: 0 });
  expect(context.tones).toHaveLength(4);
  stop();
  expect(context.tones.every((tone) => tone.stop.mock.calls.length === 1)).toBe(true);
});

test('each revolution gets one short chime followed by silence, without replaying missed passes', () => {
  sync({ id: 'satellite', angle: 0 });
  const envelope = context.gains[1];
  expect(envelope).toBeDefined();
  expect(envelope?.linearRampToValueAtTime).not.toHaveBeenCalled();
  for (let frame = 1; frame < 140; frame++) {
    sync({ id: 'satellite', angle: frame * 0.045 });
  }
  expect(envelope?.linearRampToValueAtTime).not.toHaveBeenCalled();
  context.currentTime = 3;
  sync({ id: 'satellite', angle: 6.3 });
  expect(envelope?.linearRampToValueAtTime.mock.calls).toEqual([
    [0.006, 3.04],
    [0, 3.65],
  ]);
  sync({ id: 'satellite', angle: 6.4 });
  expect(envelope?.linearRampToValueAtTime).toHaveBeenCalledTimes(2);
  context.currentTime = 20;
  sync({ id: 'satellite', angle: 12 * Math.PI });
  expect(envelope?.linearRampToValueAtTime).toHaveBeenCalledTimes(4);
  expect(envelope?.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 20.65);
  expect(context.tones).toHaveLength(2);
});
