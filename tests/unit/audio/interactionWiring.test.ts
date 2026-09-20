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

test('local boost activation, manual release and exhaustion sound once, remote simulation stays quiet', () => {
  const played: string[] = [];
  vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
    played.push(this.src);
  });
  const ship = new Ship({ kitId: 'hauler' });
  ship.isLocalPlayer = true;
  expect(ship.toggleBoost()).toBe(true);
  expect(ship.toggleBoost()).toBe(false);
  expect(played).toEqual(['/sounds/boost-start.m4a', '/sounds/boost-end.m4a']);
  ship.boost = { phase: 'active', charge: 0.0001 };
  ship.update();
  ship.update();
  expect(played).toEqual([
    '/sounds/boost-start.m4a',
    '/sounds/boost-end.m4a',
    '/sounds/boost-end.m4a',
  ]);
  ship.boost = { phase: 'exhausted', charge: 0 };
  expect(ship.toggleBoost()).toBe(false);
  expect(played).toHaveLength(3);
  ship.isLocalPlayer = false;
  ship.boost = { phase: 'idle', charge: 1 };
  ship.toggleBoost();
  expect(played).toHaveLength(3);
});
