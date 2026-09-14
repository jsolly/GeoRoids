import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Player } from '../../../../src/entities/player/Player';
import { publishHarpoonField } from '../../../../src/entities/ship/harpoonField';
import { keyDown, keyUp, reconcilePlayerInput } from '../../../../src/input/keybindings';
import { MockPlayerInput } from '../../../../src/input/MockPlayerInput';
import { setSelectedShipKitId } from '../../../../src/ui/shipKitSelect';

// Keyboard steering and combat remain usable while the ship automatically cruises.

const TURN = ((540 / 180) * Math.PI) / 60;

let player: Player;

const press = (code: string): void => keyDown(new KeyboardEvent('keydown', { code }), player);
const release = (code: string): void => keyUp(new KeyboardEvent('keyup', { code }), player);

beforeEach(() => {
  player = new Player({ id: 'p', name: 'P', type: 'local', input: new MockPlayerInput() });
  reconcilePlayerInput(player);
});

afterEach(() => {
  setSelectedShipKitId('surveyor');
  publishHarpoonField([]);
});

test('KeyW is freed while cruise continues without throttle input', () => {
  reconcilePlayerInput(player);
  press('KeyW');
  expect(player.ship.thrusting).toBe(true);
  release('KeyW');
  expect(player.ship.thrusting).toBe(true);
});

test('KeyA turns left and KeyD turns right', () => {
  press('KeyA');
  expect(player.ship.angularVelocity).toBeCloseTo(TURN, 10);
  release('KeyA');
  expect(player.ship.angularVelocity).toBeCloseTo(0, 10);

  press('KeyD');
  expect(player.ship.angularVelocity).toBeCloseTo(-TURN, 10);
  release('KeyD');
  expect(player.ship.angularVelocity).toBeCloseTo(0, 10);
});

test('Space fires while automatic thrust continues', () => {
  const shootSpy = vi.spyOn(player.ship, 'shoot');
  press('Space');
  expect(shootSpy).toHaveBeenCalledTimes(1);
  expect(player.ship.thrusting).toBe(true);
});

test('Space creates a laser end-to-end', () => {
  expect(player.ship.lasers.length).toBe(0);
  press('Space');
  expect(player.ship.lasers.length).toBe(1);
});

test('releasing Space re-arms the next shot', () => {
  player.ship.canShoot = false;
  release('Space');
  expect(player.ship.canShoot).toBe(true);
});

test('opposing turn keys (arrow + WASD) cancel out', () => {
  press('ArrowLeft');
  press('KeyD');
  expect(player.ship.angularVelocity).toBeCloseTo(0, 10);
});

test('KeyE activates the ship kit ability', () => {
  const activateSpy = vi.spyOn(player.ship, 'activateAbility');
  press('KeyE');
  expect(activateSpy).toHaveBeenCalledTimes(1);
});

test('held KeyE repeat does not re-fire the ability', () => {
  const activateSpy = vi.spyOn(player.ship, 'activateAbility');
  keyDown(new KeyboardEvent('keydown', { code: 'KeyE', repeat: true }), player);
  expect(activateSpy).not.toHaveBeenCalled();
});

test('KeyE reapplies the title Hauler kit before activate', () => {
  setSelectedShipKitId('hauler');
  publishHarpoonField([{ id: 'rock-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } }]);
  expect(player.ship.kitId).toBe('surveyor');
  press('KeyE');
  expect(player.ship.kitId).toBe('hauler');
  expect(player.ship.harpoonTargetId).toBe('rock-1');
  expect(player.ship.harpoonLatchPos).toBeTruthy();
});

test('WASD is ignored while dead', () => {
  player.lives = 0;
  reconcilePlayerInput(player);
  press('KeyW');
  press('KeyA');
  expect(player.ship.thrusting).toBe(false);
  expect(player.ship.angularVelocity).toBeCloseTo(0, 10);
});
