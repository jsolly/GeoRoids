import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GAME } from '../../../../src/constants';
import { Player } from '../../../../src/entities/player/Player';
import { resetControlSources } from '../../../../src/input/controlSources';
import { keyDown, keyUp, reconcilePlayerInput } from '../../../../src/input/keybindings';
import { MockPlayerInput } from '../../../../src/input/MockPlayerInput';

let player: Player;
const turn = (540 * Math.PI) / (180 * GAME.FPS);
const press = (code: string) => keyDown(new KeyboardEvent('keydown', { code }), player);
const release = (code: string) => keyUp(new KeyboardEvent('keyup', { code }), player);

beforeEach(() => {
  resetControlSources();
  player = new Player({
    id: 'keyboard-pilot',
    name: 'Pilot',
    type: 'local',
    input: new MockPlayerInput(),
  });
  reconcilePlayerInput(player);
});

afterEach(() => {
  resetControlSources();
  vi.restoreAllMocks();
});

test('opposing turn keys cancel and releasing either resumes the other turn', () => {
  press('ArrowLeft');
  expect(player.ship.angularVelocity).toBeCloseTo(turn);
  press('KeyD');
  expect(player.ship.angularVelocity).toBe(0);
  release('ArrowLeft');
  expect(player.ship.angularVelocity).toBeCloseTo(-turn);
  press('KeyA');
  expect(player.ship.angularVelocity).toBe(0);
  release('KeyD');
  expect(player.ship.angularVelocity).toBeCloseTo(turn);
  release('KeyA');
  expect(player.ship.angularVelocity).toBe(0);
  expect(player.ship.thrusting).toBe(true);
});

test('Space fires and release re-arms without interrupting automatic thrust', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  press('Space');
  expect(shoot).toHaveBeenCalledOnce();
  expect(player.ship.canShoot).toBe(false);
  release('Space');
  expect(player.ship.canShoot).toBe(true);
  expect(player.ship.thrusting).toBe(true);
});

test.each(['ArrowUp', 'KeyW', 'KeyZ'])(
  '%s is unbound and cannot change cruise or steering',
  (code) => {
    press('ArrowLeft');
    press(code);
    release(code);
    expect(player.ship.angularVelocity).toBeCloseTo(turn);
    expect(player.ship.thrusting).toBe(true);
  }
);

test('a dead pilot cannot restart thrust, turn, or fire', () => {
  player.lives = 0;
  reconcilePlayerInput(player);
  const shoot = vi.spyOn(player.ship, 'shoot');
  press('ArrowLeft');
  press('Space');
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.angularVelocity).toBe(0);
  expect(player.ship.thrusting).toBe(false);
});
