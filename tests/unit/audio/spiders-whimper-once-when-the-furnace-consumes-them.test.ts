import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const parameter = () => ({
  setValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
});
const createTone = () => ({
  type: 'sine',
  frequency: parameter(),
  start: vi.fn(),
  stop: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
});
class WhimperContext {
  currentTime = 1;
  destination = {};
  tones: ReturnType<typeof createTone>[] = [];
  createOscillator() {
    const tone = createTone();
    this.tones.push(tone);
    return tone;
  }
  createGain() {
    return { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() };
  }
}
const context = new WhimperContext();
let enabled = true;
const stopHooks = vi.hoisted(() => {
  const hooks: (() => void)[] = [];
  return hooks;
});
vi.mock('../../../src/audio/audioRuntime', () => ({
  getRunningAudioContext: () => (enabled ? context : null),
  registerSoundStopHook: (hook: () => void) => stopHooks.push(hook),
}));

import { bindGameAudio, resetGameAudio, withoutWorldAudio } from '../../../src/audio/spatialAudio';
import {
  getSpiderConsumptionEffects,
  setSpiderField,
} from '../../../src/physics/terrain/spiderSession';

const field = { spiders: [], nests: [] };
const event = { id: 'captured-spider', position: { x: 0, y: 0 }, furnaceId: 'furnace', frame: 100 };
const consumed = [event];
beforeEach(() => {
  enabled = true;
  setSpiderField(undefined);
  context.tones.length = 0;
  bindGameAudio({
    getListenerPosition: () => ({ x: 0, y: 0 }),
    getViewport: () => ({ width: 800, height: 600 }),
  });
});
afterEach(() => {
  setSpiderField(undefined);
  resetGameAudio();
  vi.restoreAllMocks();
});

test('nearby pilots hear one descending whimper and see one engulf effect across repeated snapshots', () => {
  setSpiderField(field);
  setSpiderField({ ...field, consumed });
  setSpiderField({ ...field, consumed });
  expect(context.tones).toHaveLength(3);
  expect(context.tones.map((tone) => tone.frequency.setValueAtTime.mock.calls[0]?.[0])).toEqual([
    659.25, 587.33, 493.88,
  ]);
  expect(getSpiderConsumptionEffects()).toHaveLength(1);
  for (const stop of stopHooks) {
    stop();
  }
  expect(
    context.tones.every(
      (tone) => tone.stop.mock.calls.length === 2 && tone.disconnect.mock.calls.length === 1
    )
  ).toBe(true);
  setSpiderField(undefined);
  expect(getSpiderConsumptionEffects()).toHaveLength(0);
});

test('joining does not replay retained events and a distant or muted intake stays silent', () => {
  setSpiderField({ ...field, consumed });
  expect(context.tones).toHaveLength(0);
  expect(getSpiderConsumptionEffects()).toHaveLength(0);
  setSpiderField({
    ...field,
    consumed: [{ ...event, frame: 101, position: { x: 5000, y: 0 } }],
  });
  enabled = false;
  setSpiderField({ ...field, consumed: [{ ...event, frame: 102 }] });
  enabled = true;
  setSpiderField({ ...field, consumed: [{ ...event, frame: 102 }] });
  withoutWorldAudio(() => setSpiderField({ ...field, consumed: [{ ...event, frame: 103 }] }));
  expect(context.tones).toHaveLength(0);
});

test('engulf effects expire after one second without another snapshot', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  setSpiderField(field);
  setSpiderField({ ...field, consumed });
  expect(getSpiderConsumptionEffects()).toHaveLength(1);
  clock.mockReturnValue(2100);
  expect(getSpiderConsumptionEffects()).toHaveLength(0);
});
