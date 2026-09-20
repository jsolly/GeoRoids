import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../src/audio/audioRuntime', () => ({
  getRunningAudioContext: () => null,
  registerSoundStopHook: vi.fn(),
}));

import {
  clearMusicThreat,
  isMusicThreatActive,
  pushMusicThreat,
  resetMusicThreats,
} from '../../../src/audio/musicThreat';
import { resetSpiderScore, updateSpiderScore } from '../../../src/audio/spiderScore';
import { setSpiderField } from '../../../src/physics/terrain/spiderSession';

beforeEach(() => {
  resetSpiderScore();
  resetMusicThreats();
});

test('a hunted pilot holds one music threat with Sound Effects off and releases it on escape', () => {
  updateSpiderScore('nearby');
  expect(isMusicThreatActive()).toBe(false);
  for (let frame = 0; frame < 120; frame++) {
    updateSpiderScore('hunted');
  }
  expect(isMusicThreatActive()).toBe(true);
  updateSpiderScore('nearby');
  expect(isMusicThreatActive()).toBe(false);
});

test('disconnect releases only the spider claim even when no more frames render', () => {
  pushMusicThreat();
  updateSpiderScore('hunted');
  setSpiderField(undefined);
  expect(isMusicThreatActive()).toBe(true);
  clearMusicThreat();
  expect(isMusicThreatActive()).toBe(false);
});

test('leaving play discards ownership so the next encounter can claim danger again', () => {
  updateSpiderScore('hunted');
  resetMusicThreats();
  window.dispatchEvent(new Event('playViewOff'));
  pushMusicThreat();
  updateSpiderScore('quiet');
  expect(isMusicThreatActive()).toBe(true);
  clearMusicThreat();
  updateSpiderScore('hunted');
  expect(isMusicThreatActive()).toBe(true);
  resetSpiderScore();
  expect(isMusicThreatActive()).toBe(false);
});
