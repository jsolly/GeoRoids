import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as explosionSound from '../../../src/audio/explosionSound';
import { bindGameAudio, resetGameAudio } from '../../../src/audio/spatialAudio';
import { playSplitSound, synthesizeSplitCrack } from '../../../src/audio/splitSound';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';

describe('collab split sound', () => {
  beforeEach(() => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
    resetGameAudio();
    bindGameAudio({
      getListenerPosition: () => ({ x: 0, y: 0 }),
      getViewport: () => ({ width: 800, height: 600 }),
    });
  });

  afterEach(() => {
    resetGameAudio();
    vi.restoreAllMocks();
    localStorage.removeItem(LOCAL_STORAGE_KEYS.soundOn);
  });

  test('in-viewport splits play the explosion layer', () => {
    const boom = vi.spyOn(explosionSound, 'playExplosionSound').mockImplementation(() => undefined);
    playSplitSound({ x: 10, y: 10 });
    expect(boom).toHaveBeenCalledWith({ x: 10, y: 10 });
  });

  test('off-viewport splits stay silent', () => {
    const boom = vi.spyOn(explosionSound, 'playExplosionSound').mockImplementation(() => undefined);
    playSplitSound({ x: 8000, y: 8000 });
    expect(boom).not.toHaveBeenCalled();
  });

  test('synthesizeSplitCrack no-ops without an audio context', () => {
    expect(synthesizeSplitCrack(0.8, null)).toBe(false);
  });
});
