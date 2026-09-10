import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { playSound, Sound, setSound } from '../../../src/audio/Sound';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { logger } from '../../../src/utils/Logger';

let testSound: Sound;
const mockPlay = vi.fn();
const mockPause = vi.fn();

beforeEach(() => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');

  testSound = new Sound('../public/sounds/thrust.m4a', 1);
  const stream = testSound.streams[0];
  expect(stream).toBeDefined();
  if (!stream) {
    throw new Error('test sound stream was not created');
  }
  stream.play = mockPlay;
  stream.pause = mockPause;
});

afterEach(() => {
  // Restore the original functions after each test
  vi.restoreAllMocks();

  localStorage.removeItem(LOCAL_STORAGE_KEYS.soundOn);
});

test('Sound', () => {
  expect(testSound).toBeInstanceOf(Sound);
  expect(testSound.streams.length).toBe(1);
});

test('Set Sound', () => {
  setSound(true);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.soundOn)).toBe('true');
  setSound(false);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.soundOn)).toBe('false');
});

test('Sound play skips when Sound is off', async () => {
  setSound(false);
  const initialStreamNum = testSound.streamNum;
  await testSound.play(1);
  expect(testSound.streamNum).toBe(initialStreamNum);
  expect(mockPlay).not.toHaveBeenCalled();
});

test('setSound(false) stops every stream that is already playing', () => {
  setSound(true);
  const extra = new Sound('../public/sounds/laser.m4a', 2);
  const first = extra.streams[0];
  const second = extra.streams[1];
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  if (!first || !second) {
    throw new Error('multi-stream sound was not created');
  }
  first.pause = mockPause;
  second.pause = mockPause;
  extra.playing = true;
  testSound.playing = true;

  setSound(false);

  expect(mockPause).toHaveBeenCalled();
  expect(testSound.playing).toBe(false);
  expect(extra.playing).toBe(false);
});

test('loop option marks every stream as looping', () => {
  const looped = new Sound('../public/sounds/thrust.m4a', 2, 0.03, { loop: true });
  expect(looped.streams[0]?.loop).toBe(true);
  expect(looped.streams[1]?.loop).toBe(true);
});

test('Sound play applies volume scale to the stream', async () => {
  const initialStreamNum = testSound.streamNum;
  await testSound.play(0.5);
  expect(testSound.streamNum).toBe((initialStreamNum + 1) % testSound.streams.length);
  expect(testSound.streams[testSound.streamNum]?.volume).toBeCloseTo(0.025);
});

test('Sound play skips when volume scale is zero', async () => {
  const initialStreamNum = testSound.streamNum;
  await testSound.play(0);
  expect(testSound.streamNum).toBe(initialStreamNum);
});

test('playSound reports an unexpected rejected playback promise', async () => {
  const cause = new Error('unexpected');
  vi.spyOn(testSound, 'play').mockRejectedValue(cause);
  const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

  playSound(testSound);
  await Promise.resolve();

  expect(log).toHaveBeenCalledWith('SOUND', 'Unexpected sound playback failure', cause);
});

test('Sound stop functionality', () => {
  testSound.stop();
  expect(mockPause).toHaveBeenCalled();
});

test('Sound isPlaying check', () => {
  // Mock the paused property
  Object.defineProperty(testSound.streams[0], 'paused', {
    value: false,
    writable: true,
  });

  expect(testSound.isPlaying()).toBe(true);

  Object.defineProperty(testSound.streams[0], 'paused', {
    value: true,
    writable: true,
  });

  expect(testSound.isPlaying()).toBe(false);
});

test('successive shots rotate through the available audio streams', async () => {
  const multiSound = new Sound('../public/sounds/thrust.m4a', 3);
  const playback = multiSound.streams.map((stream) => {
    const play = vi.fn().mockResolvedValue(undefined);
    stream.play = play;
    return play;
  });

  for (const index of [1, 2, 0]) {
    await multiSound.play();
    expect(multiSound.streamNum).toBe(index);
    expect(playback[index]).toHaveBeenCalledOnce();
  }
  expect(playback.every((play) => play.mock.calls.length === 1)).toBe(true);
});
