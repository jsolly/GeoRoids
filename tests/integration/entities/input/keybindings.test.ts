import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GAME, SHIP } from '../../../../src/constants';
import { LOCAL_STORAGE_KEYS } from '../../../../src/constants/user-preferences';
import { Player } from '../../../../src/entities/player/Player';
import { Ship } from '../../../../src/entities/ship/Ship';
import { resetControlSources } from '../../../../src/input/controlSources';
import { keyDown, keys, keyUp } from '../../../../src/input/keybindings';
import { MockPlayerInput } from '../../../../src/input/MockPlayerInput';

// Extend global interface for test-specific properties
declare global {
  // eslint-disable-next-line no-var
  var thrustSoundActive: boolean | undefined;
}

let mockPlayer: Player;
let playSpy: ReturnType<typeof vi.spyOn>;
let stopSpy: ReturnType<typeof vi.spyOn>;
let isPlayingStub: ReturnType<typeof vi.spyOn>;

const pressKey = (code: string): void => {
  const keyboardEvent = new KeyboardEvent('keydown', { code });
  keyDown(keyboardEvent, mockPlayer);
};

const releaseKey = (code: string): void => {
  const keyboardEvent = new KeyboardEvent('keyup', { code });
  keyUp(keyboardEvent, mockPlayer);
};

beforeEach(() => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
  resetControlSources();
  // Reset global key states to ensure clean test state
  keys.ArrowLeft = false;
  keys.ArrowRight = false;
  keys.Space = false;
  keys.ArrowUp = false;

  // Create spies for thrust sounds to avoid polluting global state
  playSpy = vi.spyOn(Ship.fxThrust, 'play') as ReturnType<typeof vi.spyOn>;
  stopSpy = vi.spyOn(Ship.fxThrust, 'stop');
  isPlayingStub = vi.spyOn(Ship.fxThrust, 'isPlaying');

  // Stub isPlaying to return false initially so sounds will play
  isPlayingStub.mockReturnValue(false);

  mockPlayer = new Player({
    id: 'test-player',
    name: 'TestPlayer',
    type: 'local',
    input: new MockPlayerInput(),
  });

  // Clear any lingering per-player pressed keys by simulating key releases
  releaseKey('ArrowLeft');
  releaseKey('ArrowRight');
  releaseKey('ArrowUp');
  releaseKey('Space');
});

afterEach(() => {
  resetControlSources();
  // Reset global thrust sound state
  global.thrustSoundActive = false;

  // Restore all spies to clean up global state (with null checks)
  playSpy?.mockRestore();
  stopSpy?.mockRestore();
  isPlayingStub?.mockRestore();

  // Reset all mocks
  vi.resetAllMocks();

  // Ensure no keys remain logically pressed between tests
  releaseKey('ArrowLeft');
  releaseKey('ArrowRight');
  releaseKey('ArrowUp');
  releaseKey('Space');
});

test('keyDown - Space fires and does not thrust', () => {
  const shootSpy = vi.spyOn(mockPlayer.ship, 'shoot');
  pressKey('Space');
  expect(shootSpy).toHaveBeenCalled();
  expect(mockPlayer.ship.thrusting).toBeFalsy();
  expect(playSpy).not.toHaveBeenCalled();
});

test('keyDown - ArrowLeft', () => {
  pressKey('ArrowLeft');
  expect(mockPlayer.ship.angularVelocity).toBeCloseTo(
    ((SHIP.TURN_SPEED / 180) * Math.PI) / GAME.FPS,
    10
  );
});

test('keyDown - ArrowUp', () => {
  pressKey('ArrowUp');
  expect(mockPlayer.ship.thrusting).toBeTruthy();
  expect(playSpy).toHaveBeenCalled();
});

test('keyDown - ArrowRight', () => {
  pressKey('ArrowRight');
  expect(mockPlayer.ship.angularVelocity).toBeCloseTo(
    ((-SHIP.TURN_SPEED / 180) * Math.PI) / GAME.FPS,
    10
  );
});

test('keyUp - Space re-arms shooting', () => {
  // Firing sets canShoot=false; releasing Space should re-arm the next shot
  // (mirrors the left-mouse behavior).
  mockPlayer.ship.canShoot = false;
  releaseKey('Space');
  expect(mockPlayer.ship.canShoot).toBeTruthy();
});

test('keyUp - ArrowLeft', () => {
  releaseKey('ArrowLeft');
  expect(mockPlayer.ship.angularVelocity).toBeCloseTo(0, 10);
});

test('keyUp - ArrowUp', () => {
  // Simulate ArrowUp key is already pressed and player is thrusting
  keys.ArrowUp = true;
  mockPlayer.ship.thrusting = true;

  // Simulate sound is playing for the key release
  isPlayingStub.mockReturnValue(true);
  releaseKey('ArrowUp');
  expect(mockPlayer.ship.thrusting).toBeFalsy();
  expect(stopSpy).toHaveBeenCalled();
});

test('keyUp - ArrowRight', () => {
  releaseKey('ArrowRight');
  expect(mockPlayer.ship.angularVelocity).toBeCloseTo(0, 10);
});

test('thrust persists when one of multiple thrust keys is released', () => {
  // Clear spy history
  playSpy.mockClear();
  stopSpy.mockClear();

  // Start thrust with ArrowUp
  pressKey('ArrowUp');
  expect(mockPlayer.ship.thrusting).toBeTruthy();
  expect(playSpy).toHaveBeenCalled();

  // Clear spy history again to test KeyW press doesn't call play again
  playSpy.mockClear();

  // While still holding ArrowUp, press KeyW (the WASD thrust key) too
  pressKey('KeyW');
  expect(mockPlayer.ship.thrusting).toBeTruthy();
  // Play should not be called again since sound is already playing
  expect(playSpy).not.toHaveBeenCalled();

  // Release KeyW: thrust should continue due to ArrowUp still down
  releaseKey('KeyW');
  expect(mockPlayer.ship.thrusting).toBeTruthy();

  // Finally release ArrowUp: thrust should stop
  releaseKey('ArrowUp');
  expect(mockPlayer.ship.thrusting).toBeFalsy();
  expect(stopSpy).toHaveBeenCalled();
});

test('keyUp - ArrowLeft with ArrowRight still down', () => {
  pressKey('ArrowRight');
  releaseKey('ArrowLeft');
  expect(mockPlayer.ship.angularVelocity).toBeCloseTo(
    ((-SHIP.TURN_SPEED / 180) * Math.PI) / GAME.FPS,
    10
  );
});

test('keyUp - ArrowRight with ArrowLeft still down', () => {
  pressKey('ArrowLeft');
  releaseKey('ArrowRight');
  expect(mockPlayer.ship.angularVelocity).toBeCloseTo(
    ((SHIP.TURN_SPEED / 180) * Math.PI) / GAME.FPS,
    10
  );
});

test('keyDown - non-specified key', () => {
  const initialAngularVelocity = mockPlayer.ship.angularVelocity;
  const initialThrusting = mockPlayer.ship.thrusting;

  // KeyZ is unbound (KeyA/KeyW/KeyD are now WASD controls).
  pressKey('KeyZ');

  expect(mockPlayer.ship.angularVelocity).toEqual(initialAngularVelocity);
  expect(mockPlayer.ship.thrusting).toEqual(initialThrusting);
  expect(playSpy).not.toHaveBeenCalled();
});

test('keyDown - blocked when player is dead', () => {
  // Set player to have no lives (dead)
  mockPlayer.lives = 0;

  const initialAngularVelocity = mockPlayer.ship.angularVelocity;
  const initialThrusting = mockPlayer.ship.thrusting;

  pressKey('Space');
  pressKey('ArrowLeft');
  pressKey('ArrowUp');

  // Input should be blocked when player is dead
  expect(mockPlayer.ship.angularVelocity).toEqual(initialAngularVelocity);
  expect(mockPlayer.ship.thrusting).toEqual(initialThrusting);
  expect(playSpy).not.toHaveBeenCalled();
});

test('keyUp - non-specified key', () => {
  const initialAngularVelocity = mockPlayer.ship.angularVelocity;
  const initialThrusting = mockPlayer.ship.thrusting;

  releaseKey('KeyZ');

  expect(mockPlayer.ship.angularVelocity).toEqual(initialAngularVelocity);
  expect(mockPlayer.ship.thrusting).toEqual(initialThrusting);
  expect(playSpy).not.toHaveBeenCalled();
});
