import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Sound, setSound } from '../../../src/audio/Sound';
import { bindGameAudio, resetGameAudio } from '../../../src/audio/spatialAudio';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Ship } from '../../../src/entities/ship/Ship';

const listener = { x: 400, y: 300 };

beforeEach(() => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
  resetGameAudio();
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => ({ width: 800, height: 600 }),
  });
});

afterEach(() => {
  resetGameAudio();
  setSound(false);
  vi.restoreAllMocks();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.soundOn);
});

describe('game interaction sound wiring', () => {
  test('a persistent Hauler latch releases without a timer-driven sound', () => {
    const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
    const ship = new Ship({ kitId: 'hauler' });
    ship.harpoonTargetId = 'rock-1';
    ship.harpoonLatchPos = { x: 420, y: 300 };

    expect(ship.activateAbility()).toBe(true);
    expect(ship.harpoonTargetId).toBeNull();
    expect(ship.harpoonLatchPos).toBeUndefined();
    expect(playSpy).not.toHaveBeenCalled();
  });
});
