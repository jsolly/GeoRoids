import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TOWN_HEARTH } from '../../../../shared/furnaces';
import { Player } from '../../../../src/entities/player/Player';
import { publishHarpoonField } from '../../../../src/entities/ship/harpoonField';
import { controlSources, resetControlSources } from '../../../../src/input/controlSources';
import { keyDown, keyUp, reconcilePlayerInput } from '../../../../src/input/keybindings';

import { setSelectedShipKitId } from '../../../../src/runtime/shipSelection';

// Steering and combat remain independent of manual propulsion.

const TURN = ((540 / 180) * Math.PI) / 60;

let player: Player;

const press = (code: string): void => keyDown(new KeyboardEvent('keydown', { code }), player);
const release = (code: string): void => keyUp(new KeyboardEvent('keyup', { code }), player);

beforeEach(() => {
  resetControlSources();
  player = new Player({ id: 'p', name: 'P', type: 'local' });
  reconcilePlayerInput(player);
});

afterEach(() => {
  resetControlSources();
  vi.restoreAllMocks();
  setSelectedShipKitId('scout');
  publishHarpoonField([]);
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

test('Shift toggles Contour Lock on and off without holding', () => {
  vi.spyOn(player.ship, 'toggleContourLock').mockImplementation(() => {
    player.ship.contourLock = player.ship.contourLocked ? null : { height: 0.1, direction: 1 };
    return player.ship.contourLocked;
  });
  expect(player.ship.contourLocked).toBe(false);
  press('ShiftLeft');
  expect(player.ship.contourLocked).toBe(true);
  release('ShiftLeft');
  expect(player.ship.contourLocked).toBe(true);
  press('ShiftRight');
  expect(player.ship.contourLocked).toBe(false);
  keyDown(new KeyboardEvent('keydown', { code: 'ShiftLeft', repeat: true }), player);
  expect(player.ship.contourLocked).toBe(false);
});

test('KeyE preserves the joined Scout when the title menu has a stale Hauler selection', () => {
  setSelectedShipKitId('hauler');
  publishHarpoonField([{ id: 'rock-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } }]);
  expect(player.ship.kitId).toBe('scout');
  const health = player.ship.health;
  press('KeyE');
  expect(player.ship.kitId).toBe('scout');
  expect(player.ship.health).toBe(health);
  expect(player.ship.harpoonTargetId).toBeNull();
});

test.each(['scout', 'hauler'] as const)(
  'a loaded high-mass %s stops at a furnace until steering or unloading',
  (kitId) => {
    player = new Player({ id: 'carrier', name: 'Carrier', type: 'local', kitId });
    player.ship.mass = 8;
    player.cargo = 400;
    player.ship.position = { x: 0, y: 0 };
    player.ship.velocity = { x: 3, y: 1 };
    reconcilePlayerInput(player);
    player.ship.update();
    expect(player.ship.cargoHover).toBe(true);
    expect(player.ship.velocity).toEqual({ x: 0, y: 0 });
    expect(player.ship.thrusting).toBe(false);
    press('ArrowLeft');
    expect(player.ship.cargoHover).toBe(false);
    expect(player.ship.thrusting).toBe(false);
    release('ArrowLeft');
    reconcilePlayerInput(player);
    expect(player.ship.cargoHover).toBe(false);
    player.ship.position = { x: 200, y: 0 };
    reconcilePlayerInput(player);
    player.ship.position = { x: 0, y: 0 };
    reconcilePlayerInput(player);
    expect(player.ship.cargoHover).toBe(true);
    player.cargo = 0;
    reconcilePlayerInput(player);
    expect(player.ship.cargoHover).toBe(false);
    expect(player.ship.thrusting).toBe(false);
  }
);

test.each(['scout', 'hauler'] as const)(
  '%s catches the furnace rim despite its approach heading and releases on fresh steering',
  (kitId) => {
    player = new Player({
      id: 'rim-pilot',
      name: 'Pilot',
      type: 'local',
      kitId,
    });
    player.cargo = 400;
    player.ship.angle = 0;
    const rim = TOWN_HEARTH.radius + player.ship.r;
    player.ship.position = { x: rim + 1, y: 0 };
    controlSources.pointerHeading = Math.PI / 2;
    reconcilePlayerInput(player);
    expect(player.ship.cargoHover).toBe(false);
    expect(player.ship.angularVelocity).not.toBe(0);
    player.ship.position = { x: rim - 1, y: 0 };
    player.ship.velocity = { x: -3, y: 0 };
    const touchEpoch = controlSources.steeringEpoch;
    reconcilePlayerInput(player);
    player.ship.update();
    expect(player.ship.position.x).toBeGreaterThan(TOWN_HEARTH.radius);
    expect(player.ship.velocity).toEqual({ x: 0, y: 0 });
    expect(player.ship.cargoHover).toBe(true);
    expect(player.ship.angularVelocity).toBe(0);
    expect(controlSources.steeringEpoch).toBe(touchEpoch);
    controlSources.pointerHeading = Math.PI / 2;
    reconcilePlayerInput(player);
    expect(player.ship.cargoHover).toBe(false);
    press('KeyW');
    player.ship.update();
    expect(player.ship.velocity).not.toEqual({ x: 0, y: 0 });
    controlSources.pointerHeading = null;
    reconcilePlayerInput(player);
    expect(player.ship.cargoHover).toBe(false);
  }
);

test('opposing turn keys cancel and releasing either resumes the other turn', () => {
  press('ArrowLeft');
  expect(player.ship.angularVelocity).toBeCloseTo(TURN);
  press('KeyD');
  expect(player.ship.angularVelocity).toBe(0);
  release('ArrowLeft');
  expect(player.ship.angularVelocity).toBeCloseTo(-TURN);
  press('KeyA');
  expect(player.ship.angularVelocity).toBe(0);
  release('KeyD');
  expect(player.ship.angularVelocity).toBeCloseTo(TURN);
  release('KeyA');
  expect(player.ship.angularVelocity).toBe(0);
  expect(player.ship.thrusting).toBe(false);
});

test('Space fires and release re-arms without starting propulsion', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  expect(player.ship.lasers).toHaveLength(0);
  press('Space');
  expect(shoot).toHaveBeenCalledOnce();
  expect(player.ship.lasers).toHaveLength(1);
  expect(player.ship.thrusting).toBe(false);
  expect(player.ship.canShoot).toBe(false);
  release('Space');
  expect(player.ship.canShoot).toBe(true);
  expect(player.ship.thrusting).toBe(false);
});

test.each(['ArrowUp', 'KeyW'])('%s supplies thrust without changing steering', (code) => {
  press('ArrowLeft');
  press(code);
  expect(player.ship.angularVelocity).toBeCloseTo(TURN);
  expect(player.ship.thrusting).toBe(true);
  release(code);
  expect(player.ship.angularVelocity).toBeCloseTo(TURN);
  expect(player.ship.thrusting).toBe(false);
});

test('a dead pilot cannot restart thrust, turn, or fire', () => {
  player.ship.health = 0;
  reconcilePlayerInput(player);
  const shoot = vi.spyOn(player.ship, 'shoot');
  press('ArrowLeft');
  press('Space');
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.angularVelocity).toBe(0);
  expect(player.ship.thrusting).toBe(false);
});

test.each(['scout', 'hauler'] as const)('a %s turns at the same 540-degree pace', (kitId) => {
  player = new Player({ id: 'turner', name: 'Turner', type: 'local', kitId });
  player.ship.mass = 8;
  player.ship.position = { x: 2000, y: 0 };
  player.ship.angle = 0;
  press('ArrowLeft');
  player.ship.update();
  expect(player.ship.angle).toBeCloseTo(TURN, 10);
  release('ArrowLeft');
  expect(player.ship.angularVelocity).toBe(0);
});

test('held thrust repeats preserve Contour Lock while a fresh thrust press releases it', () => {
  press('KeyW');
  player.ship.contourLock = { height: 0.1, direction: 1 };
  keyDown(new KeyboardEvent('keydown', { code: 'KeyW', repeat: true }), player);
  expect(player.ship.contourLocked).toBe(true);
  release('KeyW');
  press('KeyW');
  expect(player.ship.contourLocked).toBe(false);
  expect(player.ship.thrusting).toBe(true);
});
