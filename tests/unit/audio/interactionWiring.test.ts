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
  test('a regular shield activation sounds once and deactivation stays quiet', () => {
    const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
    const ship = new Ship({ isLocalPlayer: true });

    expect(ship.requestShieldToggle()).toBe(true);
    expect(playSpy).toHaveBeenCalledTimes(1);

    expect(ship.requestShieldToggle()).toBe(true);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  test('a harpoon timer crossing to zero sounds once per release', () => {
    const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
    const ship = new Ship({ kitId: 'hauler' });
    ship.harpoonTimer = 1;
    ship.harpoonLatchPos = { x: 420, y: 300 };

    ship.updateLifecycle(1);
    expect(playSpy).toHaveBeenCalledTimes(1);

    ship.updateLifecycle(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});
