import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  playLootPickup,
  playTapEjection,
  resetResourceMusic,
} from '../../../src/audio/resourceMusic';
import { Sound, setSound } from '../../../src/audio/Sound';
import { bindGameAudio, resetGameAudio, withoutWorldAudio } from '../../../src/audio/spatialAudio';

const position = { x: 0, y: 0 };
let now = 0;
let notes: Array<{ src: string; semitones: number; volume: number }>;

beforeEach(() => {
  localStorage.setItem('soundOn', 'true');
  resetResourceMusic();
  now = 0;
  notes = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Sound.prototype, 'playNote').mockImplementation(function (
    this: Sound,
    volume,
    semitones
  ) {
    notes.push({ src: this.src, volume, semitones });
    return true;
  });
  bindGameAudio({
    getListenerPosition: () => position,
    getViewport: () => ({ width: 800, height: 600 }),
  });
});
afterEach(() => {
  setSound(false);
  resetGameAudio();
  vi.restoreAllMocks();
});

test('three pickups answer lower extraction notes with E, G, C and a longer streak varies', () => {
  playTapEjection(position);
  playLootPickup('tap', position);
  now += 350;
  playTapEjection(position);
  playLootPickup('shard', position);
  now += 350;
  playTapEjection(position);
  playLootPickup('wreckage', position);
  expect(
    notes.filter((note) => note.src.includes('tap-eject')).map((note) => note.semitones)
  ).toEqual([0, 7, 4]);
  expect(
    notes.filter((note) => note.src.includes('loot-pickup')).map((note) => note.semitones)
  ).toEqual([4, 7, 12]);
  for (let i = 0; i < 9; i++) {
    now += 200;
    playLootPickup('tap', position);
  }
  expect(notes.slice(-9).map((note) => note.semitones)).toEqual([2, 4, 9, 7, 9, 16, 7, 4, 12]);
  now += 1500;
  playLootPickup('laserCore', position);
  expect(notes.at(-1)).toMatchObject({ src: '/sounds/core-pickup.m4a', semitones: 4 });
});

test('simultaneous pickups form a chord immediately and a mute starts a fresh phrase', () => {
  for (let i = 0; i < 3; i++) {
    playLootPickup('tap', position);
  }
  expect(notes.map((note) => note.semitones)).toEqual([4, 7, 12]);
  setSound(false);
  playTapEjection(position);
  playLootPickup('tap', position);
  expect(notes).toHaveLength(3);
  localStorage.setItem('soundOn', 'true');
  playLootPickup('tap', position);
  expect(notes.at(-1)?.semitones).toBe(4);
});

test('offscreen, reconnect-baseline and unavailable voices do not consume melody notes', () => {
  playTapEjection({ x: 5000, y: 0 });
  playLootPickup('tap', { x: 5000, y: 0 });
  withoutWorldAudio(() => {
    playTapEjection(position);
    playLootPickup('tap', position);
  });
  expect(notes).toEqual([]);
  vi.mocked(Sound.prototype.playNote).mockReturnValueOnce(false);
  playLootPickup('tap', position);
  playLootPickup('tap', position);
  expect(notes.map((note) => note.semitones)).toEqual([4]);
  playLootPickup('shard', { x: 100, y: 0 });
  expect(notes.at(-1)?.semitones).toBe(7);
  expect(notes.at(-1)?.volume).toBeLessThan(1);
  resetResourceMusic();
  playLootPickup('tap', position);
  expect(notes.at(-1)?.semitones).toBe(4);
});
