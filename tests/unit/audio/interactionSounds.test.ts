import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  playAbilityActivation,
  playHarpoonLatch,
  playHarpoonLaunch,
  playHarpoonRelease,
  playLootPickup,
  playOrbitalFire,
  playOrbitalPickup,
  playRespawn,
  playShieldActivation,
} from '../../../src/audio/interactionSounds';
import { Sound, setSound } from '../../../src/audio/Sound';
import { bindGameAudio, resetGameAudio } from '../../../src/audio/spatialAudio';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';

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

describe('interaction sound cues', () => {
  test('each meaningful interaction uses its own pooled sound instance', () => {
    const played: Sound[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      played.push(this);
      return Promise.resolve();
    });

    playHarpoonLaunch(listener);
    playHarpoonLatch(listener);
    playHarpoonRelease(listener);
    playOrbitalFire(listener);
    playOrbitalPickup(listener);
    playLootPickup('shard', listener);
    playLootPickup('fuel', listener);
    playLootPickup('laserCore', listener);
    playAbilityActivation('boostDash', listener);
    playAbilityActivation('shieldFocus', listener);
    playAbilityActivation('ringFire', listener);
    playAbilityActivation('shockPulse', listener);
    playRespawn(listener);

    expect(played).toHaveLength(13);
    expect(new Set(played).size).toBe(13);
    expect(played.map((sound) => sound.src.split('/').pop())).toEqual([
      'harpoon-launch.m4a',
      'harpoon-latch.m4a',
      'harpoon-release.m4a',
      'orbital-fire.m4a',
      'orbital-pickup.m4a',
      'loot-pickup.m4a',
      'fuel-pickup.m4a',
      'core-pickup.m4a',
      'ability-boost.m4a',
      'ability-shield.m4a',
      'ability-ring.m4a',
      'ability-pulse.m4a',
      'respawn.m4a',
    ]);
    playLootPickup('wreckage', listener);
    expect(played[13]).toBe(played[5]);
  });

  test('world interaction cues use viewport culling and distance attenuation', () => {
    const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);

    playOrbitalFire({ x: listener.x + 1000, y: listener.y });
    expect(playSpy).not.toHaveBeenCalled();

    playOrbitalFire({ x: listener.x + 100, y: listener.y });
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(playSpy.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(playSpy.mock.calls[0]?.[0]).toBeLessThan(1);
  });

  test('sound preference mutes every interaction cue', () => {
    const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
    setSound(false);

    playHarpoonLaunch(listener);
    playHarpoonLatch(listener);
    playHarpoonRelease(listener);
    playOrbitalFire(listener);
    playOrbitalPickup(listener);
    playLootPickup('fuel', listener);
    playAbilityActivation('shockPulse', listener);
    playRespawn(listener);

    expect(playSpy).not.toHaveBeenCalled();
  });

  test('the regular shield cue shares the Warden shield sound', () => {
    const played: Sound[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      played.push(this);
      return Promise.resolve();
    });

    playShieldActivation(listener);
    playAbilityActivation('shieldFocus', listener);

    expect(played).toHaveLength(2);
    expect(played[0]).toBe(played[1]);
  });
});
