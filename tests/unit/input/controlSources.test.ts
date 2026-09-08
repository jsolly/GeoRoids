import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GAME, SHIP } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import { keyDown, keyUp, reconcilePlayerInput } from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  applyStickSample,
  setTouchFire,
  tickTouchControls,
} from '../../../src/input/touchControls';
import { readStickSample } from '../../../src/input/touchStick';

const TURN = ((SHIP.TURN_SPEED / 180) * Math.PI) / GAME.FPS;

let player: Player;

beforeEach(() => {
  resetControlSources();
  player = new Player({
    id: 'touch-player',
    name: 'Touchy',
    type: 'local',
    input: new MockPlayerInput(),
  });
});

afterEach(() => {
  resetControlSources();
  vi.restoreAllMocks();
});

function press(code: string): void {
  keyDown(new KeyboardEvent('keydown', { code }), player);
}

function release(code: string): void {
  keyUp(new KeyboardEvent('keyup', { code }), player);
}

test('keyboard thrust is unchanged when the stick is idle', () => {
  press('ArrowUp');
  expect(player.ship.thrusting).toBe(true);
  release('ArrowUp');
  expect(player.ship.thrusting).toBe(false);
});

test('releasing a thrust key keeps thrusting while the stick is held', () => {
  const sample = readStickSample(80, 0, 0, 0);
  applyStickSample(player, sample);
  press('ArrowUp');
  expect(player.ship.thrusting).toBe(true);
  release('ArrowUp');
  expect(player.ship.thrusting).toBe(true);
  applyStickSample(player, null);
  expect(player.ship.thrusting).toBe(false);
});

test('right-mouse thrust still composes with keys', () => {
  controlSources.mouseThrust = true;
  reconcilePlayerInput(player);
  expect(player.ship.thrusting).toBe(true);
  controlSources.mouseThrust = false;
  reconcilePlayerInput(player);
  expect(player.ship.thrusting).toBe(false);
});

test('stick heading matches mouse-style aim and does not fight WASD turn', () => {
  const sample = readStickSample(0, -80, 0, 0);
  applyStickSample(player, sample);
  expect(player.ship.angle).toBeCloseTo(Math.PI / 2, 8);
  expect(player.ship.angularVelocity).toBe(0);

  press('ArrowLeft');
  expect(player.ship.angularVelocity).toBeCloseTo(TURN, 10);
  release('ArrowLeft');
  expect(player.ship.angle).toBeCloseTo(Math.PI / 2, 8);
});

test('fire button shoots once and re-arms on release', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  setTouchFire(player, true);
  expect(shoot).toHaveBeenCalledTimes(1);
  player.ship.canShoot = false;
  setTouchFire(player, false);
  expect(player.ship.canShoot).toBe(true);
});

test('dead player cannot fire from the overlay', () => {
  player.lives = 0;
  const shoot = vi.spyOn(player.ship, 'shoot');
  setTouchFire(player, true);
  expect(shoot).not.toHaveBeenCalled();
});

test('hold-to-fire keeps calling shoot while the button is down', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  setTouchFire(player, true);
  tickTouchControls(player);
  tickTouchControls(player);
  expect(shoot.mock.calls.length).toBeGreaterThanOrEqual(3);
});
