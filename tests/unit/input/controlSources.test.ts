import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GAME } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import { keyDown, keyUp, reconcilePlayerInput } from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { setTouchFire, setTouchHeading, tickTouchControls } from '../../../src/input/touchControls';

const TURN = ((540 / 180) * Math.PI) / GAME.FPS;

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

test('cruise starts without a held control and the freed throttle keys do not change it', () => {
  reconcilePlayerInput(player);
  expect(player.ship.thrusting).toBe(true);
  for (const code of ['ArrowUp', 'KeyW']) {
    press(code);
    release(code);
    expect(player.ship.thrusting).toBe(true);
  }
});

test('keyboard steering takes over from the pointer and release keeps cruising on the new heading', () => {
  setTouchHeading(player, 0);
  press('ArrowLeft');
  expect(player.ship.angularVelocity).toBeCloseTo(TURN);
  player.ship.update();
  release('ArrowLeft');
  expect(player.ship.angularVelocity).toBe(0);
  expect(player.ship.thrusting).toBe(true);
  expect(controlSources.pointerHeading).toBeNull();
});

test('touch turns toward the finger at the kit limit and release keeps the attained heading', () => {
  player.ship.angle = 0;
  setTouchHeading(player, Math.PI / 2);
  expect(player.ship.angle).toBe(0);
  expect(player.ship.angularVelocity).toBeCloseTo(TURN, 10);
  player.ship.update();
  expect(player.ship.angle).toBeCloseTo(TURN, 10);
  setTouchHeading(player, null);
  const angle = player.ship.angle;
  player.ship.update();
  expect(player.ship.angle).toBe(angle);
  expect(player.ship.thrusting).toBe(true);
  expect(Math.hypot(player.ship.velocity.x, player.ship.velocity.y)).toBeGreaterThan(0);
});

test('touch takes the short route across the angle wrap and settles without overshoot', () => {
  player.ship.angle = Math.PI - TURN / 4;
  setTouchHeading(player, -Math.PI + TURN / 4);
  expect(player.ship.angularVelocity).toBeCloseTo(TURN / 2);
  player.ship.update();
  tickTouchControls(player);
  expect(player.ship.angularVelocity).toBeCloseTo(0);
});

test('firing touch shoots once and re-arms on release', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  setTouchFire(player, true);
  expect(shoot).toHaveBeenCalledTimes(1);
  player.ship.canShoot = false;
  setTouchFire(player, false);
  expect(player.ship.canShoot).toBe(true);
});

test('dead player cannot fire from touch input', () => {
  player.ship.health = 0;
  const shoot = vi.spyOn(player.ship, 'shoot');
  setTouchFire(player, true);
  expect(shoot).not.toHaveBeenCalled();
});

test('hold-to-fire keeps calling shoot while the firing finger is down', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  setTouchFire(player, true);
  tickTouchControls(player);
  tickTouchControls(player);
  expect(shoot.mock.calls.length).toBeGreaterThanOrEqual(3);
});
