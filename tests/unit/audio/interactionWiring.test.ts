import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Sound, setSound } from '../../../src/audio/Sound';
import { bindGameAudio, resetGameAudio } from '../../../src/audio/spatialAudio';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { Ship } from '../../../src/entities/ship/Ship';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

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

test('a local pilot hears one cue for acquisition and one for release, with no extra cue on rail changes', () => {
  const played: string[] = [];
  vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
    played.push(this.src);
  });
  const ship = new Ship({
    isLocalPlayer: true,
    position: { x: 2253.9780217479483, y: -0.007169463344477992 },
  });
  expect(ship.toggleContourLock()).toBe(true);
  const state = ship.contourLock;
  if (!state) {
    throw new Error('Missing captured rail');
  }
  ship.contourLock = { ...state, direction: -1 };
  ship.contourLock = { ...state };
  ship.releaseContourLock();
  ship.releaseContourLock();
  expect(played).toEqual([
    '/sounds/contour-lock-acquired.m4a',
    '/sounds/contour-lock-released.m4a',
  ]);
});

test('authoritative release sounds once locally while remote lock snapshots stay silent', () => {
  const played: string[] = [];
  vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
    played.push(this.src);
  });
  const ship = new Ship({ isLocalPlayer: true });
  ship.contourLock = { height: 0.16, direction: 1 };
  ship.contourLock = null;
  ship.contourLock = null;
  const remote = new Ship();
  remote.contourLock = { height: 0.16, direction: 1 };
  remote.releaseContourLock();
  expect(played).toEqual([
    '/sounds/contour-lock-acquired.m4a',
    '/sounds/contour-lock-released.m4a',
  ]);
});

test('tow snapshots sound launch, attachment and disengagement once even when repeated', () => {
  const played: string[] = [];
  vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
    played.push(this.src);
  });
  const player = new Player({
    id: 'tow-audio',
    name: 'Hauler',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });
  player.ship.position = { ...listener };
  const outbound = {
    utilityFlight: {
      kind: 'tow' as const,
      phase: 'outbound' as const,
      position: { ...listener },
      velocity: { x: 10, y: 0 },
      remainingDistance: 100,
    },
    harpoonTargetId: null,
  };
  player.updateFromServer(outbound);
  player.updateFromServer(outbound);
  const latched = {
    utilityFlight: null,
    harpoonTargetId: 'rock',
    harpoonLatchPos: { ...listener },
  };
  player.updateFromServer(latched);
  player.updateFromServer(latched);
  player.updateFromServer({ harpoonTargetId: null });
  player.updateFromServer({ harpoonTargetId: null });
  expect(played).toEqual([
    '/sounds/harpoon-launch.m4a',
    '/sounds/harpoon-latch.m4a',
    '/sounds/harpoon-release.m4a',
  ]);
});

test('recalling or losing an outgoing tow sounds disengagement without a false attachment', () => {
  const played: string[] = [];
  vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
    played.push(this.src);
  });
  const player = new Player({
    id: 'recall-audio',
    name: 'Hauler',
    type: 'local',
    input: new MockPlayerInput(),
    kitId: 'hauler',
  });
  player.ship.position = { ...listener };
  player.updateFromServer({
    utilityFlight: {
      kind: 'tow',
      phase: 'outbound',
      position: { ...listener },
      velocity: { x: 10, y: 0 },
      remainingDistance: 100,
    },
  });
  player.updateFromServer({ utilityFlight: null, harpoonTargetId: null });
  player.updateFromServer({ utilityFlight: null, harpoonTargetId: null });
  expect(played).toEqual(['/sounds/harpoon-launch.m4a', '/sounds/harpoon-release.m4a']);
});

test.each([false, true])(
  'death cancels an outgoing tow audibly even after predicted cleanup: %s',
  (predicted) => {
    const played: string[] = [];
    vi.spyOn(Sound.prototype, 'play').mockImplementation(function (this: Sound) {
      played.push(this.src);
    });
    const player = new Player({
      id: 'death-tow',
      name: 'Hauler',
      type: 'local',
      input: new MockPlayerInput(),
      kitId: 'hauler',
    });
    player.ship.position = { ...listener };
    player.updateFromServer({
      utilityFlight: {
        kind: 'tow',
        phase: 'outbound',
        position: { ...listener },
        velocity: { x: 10, y: 0 },
        remainingDistance: 100,
      },
    });
    if (predicted) {
      player.ship.explode();
    }
    const death = { exploding: true, utilityFlight: null, harpoonTargetId: null };
    player.updateFromServer(death);
    player.updateFromServer(death);
    expect(played.filter((src) => src.includes('harpoon'))).toEqual([
      '/sounds/harpoon-launch.m4a',
      '/sounds/harpoon-release.m4a',
    ]);
  }
);
