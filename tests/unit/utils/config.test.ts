import { beforeEach, expect, test } from 'vitest';

import { ROID } from '../../../src/constants';
import { LOCAL_STORAGE_KEYS, musicIsOn, soundIsOn } from '../../../src/constants/user-preferences';

beforeEach(() => {
  localStorage.clear();
});

test('Local Storage Keys', () => {
  expect(LOCAL_STORAGE_KEYS.soundOn).toBe('soundOn');
  expect(LOCAL_STORAGE_KEYS.musicOn).toBe('musicOn');
});

test('Sound On', () => {
  localStorage.setItem('soundOn', 'true');
  expect(soundIsOn()).toBe(true);
});

test('Sound Off', () => {
  localStorage.setItem('soundOn', 'false');
  expect(soundIsOn()).toBe(false);
});

test('Music defaults on until a pilot turns it off', () => {
  expect(musicIsOn()).toBe(true);
  localStorage.setItem('musicOn', 'false');
  expect(musicIsOn()).toBe(false);
  localStorage.setItem('musicOn', 'true');
  expect(musicIsOn()).toBe(true);
});

test('ROID_NUM constant', () => {
  expect(ROID.INITIAL_ROID_COUNT).toBe(20);
});
