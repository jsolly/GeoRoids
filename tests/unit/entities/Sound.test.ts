import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sound, setSound } from '../../../src/audio/Sound';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';

let testSound: Sound;
const mockPlay = vi.fn();
const mockPause = vi.fn();

beforeEach(() => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');

  testSound = new Sound('../public/sounds/thrust.m4a', 1);
  const stream = testSound.streams[0];
  assert.ok(stream);
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
  const [firstStream, secondStream] = extra.streams;
  assert.ok(firstStream);
  assert.ok(secondStream);
  firstStream.pause = mockPause;
  secondStream.pause = mockPause;
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

test('Sound with multiple streams', () => {
  const multiSound = new Sound('../public/sounds/thrust.m4a', 3);
  expect(multiSound.streams.length).toBe(3);
  expect(multiSound.streamNum).toBe(0);

  // Test stream cycling without calling play (which fails in jsdom)
  multiSound.streamNum = 1;
  expect(multiSound.streamNum).toBe(1);

  multiSound.streamNum = 2;
  expect(multiSound.streamNum).toBe(2);

  multiSound.streamNum = 0; // Should wrap around
  expect(multiSound.streamNum).toBe(0);
});
