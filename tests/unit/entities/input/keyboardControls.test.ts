import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FUEL, GAME, SHIP } from '../../../../src/constants';
import { Player } from '../../../../src/entities/player/Player';
import { publishHarpoonField } from '../../../../src/entities/ship/harpoonField';
import { applyShipKitToShip } from '../../../../src/entities/ship/shipKits';
import { keyDown, keyUp } from '../../../../src/input/keybindings';
import { MockPlayerInput } from '../../../../src/input/MockPlayerInput';
import { setSelectedShipKitId } from '../../../../src/ui/shipKitSelect';

// Covers the "controls appeared unresponsive" report: WASD did nothing and
// Space did not fire. Movement now supports WASD alongside the arrow keys, and
// Space is the fire key (matching the documented "thrust = arrows, fire =
// Space" scheme), so keyboard-only players can move AND shoot.

const TURN = ((SHIP.TURN_SPEED / 180) * Math.PI) / GAME.FPS;

let player: Player;

const press = (code: string): void => keyDown(new KeyboardEvent('keydown', { code }), player);
const release = (code: string): void => keyUp(new KeyboardEvent('keyup', { code }), player);

beforeEach(() => {
  player = new Player({ id: 'p', name: 'P', type: 'local', input: new MockPlayerInput() });
});

afterEach(() => {
  setSelectedShipKitId('dart');
  publishHarpoonField([]);
});

test('KeyW thrusts and releasing it stops thrust', () => {
  press('KeyW');
  expect(player.ship.thrusting).toBe(true);
  release('KeyW');
  expect(player.ship.thrusting).toBe(false);
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

test('Space fires (calls shoot) and does not thrust', () => {
  const shootSpy = vi.spyOn(player.ship, 'shoot');
  press('Space');
  expect(shootSpy).toHaveBeenCalledTimes(1);
  expect(player.ship.thrusting).toBe(false);
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
  expect(player.ship.kitId).toBe('dart');
  press('KeyE');
  expect(player.ship.kitId).toBe('hauler');
  expect(player.ship.harpoonTimer).toBeGreaterThan(0);
  expect(player.ship.harpoonLatchPos).toBeTruthy();
});

test('KeyE on Dart does not spend fuel', () => {
  const startFuel = player.ship.fuel;
  press('KeyE');
  expect(player.ship.fuel).toBe(startFuel);
});

test('KeyE on Quake spends EMP fuel', () => {
  applyShipKitToShip(player.ship, 'quake');
  const startFuel = player.ship.fuel;
  press('KeyE');
  expect(player.ship.fuel).toBe(startFuel - FUEL.EMP_COST);
});

test('KeyE on Quake does nothing when the tank is empty', () => {
  applyShipKitToShip(player.ship, 'quake');
  player.ship.fuel = 0;
  press('KeyE');
  expect(player.ship.abilityActiveFrames).toBe(0);
  expect(player.ship.fuel).toBe(0);
});

test('KeyF toggles the local ship shield and KeyF again drops it into cooldown', () => {
  expect(player.ship.shieldActive).toBe(false);
  press('KeyF');
  expect(player.ship.shieldActive).toBe(true);
  expect(player.ship.shieldTime).toBeGreaterThan(0);

  press('KeyF');
  expect(player.ship.shieldActive).toBe(false);
  expect(player.ship.shieldCooldown).toBeGreaterThan(0);

  press('KeyF');
  expect(player.ship.shieldActive).toBe(false);
});

test('WASD is ignored while dead', () => {
  player.lives = 0;
  press('KeyW');
  press('KeyA');
  expect(player.ship.thrusting).toBe(false);
  expect(player.ship.angularVelocity).toBeCloseTo(0, 10);
});
