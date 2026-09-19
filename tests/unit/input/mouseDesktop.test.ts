import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { resetControlSources } from '../../../src/input/controlSources';
import { reconcilePlayerInput } from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { handleMouseDown, handleMouseUp } from '../../../src/input/mouse';
import { setShipSchematicOpen } from '../../../src/ui/shipSchematicState';

let player: Player;

beforeEach(() => {
  resetControlSources();
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
  player = new Player({
    id: 'mouse-desktop',
    name: 'Desk',
    type: 'local',
    input: new MockPlayerInput(),
  });
  reconcilePlayerInput(player);
});

afterEach(() => {
  setShipSchematicOpen(false);
  resetControlSources();
  vi.restoreAllMocks();
});

test('left click still fires and release re-arms', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  handleMouseDown(new MouseEvent('mousedown', { button: 0 }), player);
  expect(shoot).toHaveBeenCalledTimes(1);
  player.ship.canShoot = false;
  handleMouseUp(new MouseEvent('mouseup', { button: 0 }), player);
  expect(player.ship.canShoot).toBe(true);
});

test('right click toggles boost without firing or interrupting cruise', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  expect(player.ship.boosting).toBe(false);
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(player.ship.boosting).toBe(true);
  expect(player.ship.thrusting).toBe(true);
  expect(shoot).not.toHaveBeenCalled();
  handleMouseUp(new MouseEvent('mouseup', { button: 2 }), player);
  expect(player.ship.boosting).toBe(true);
  expect(player.ship.thrusting).toBe(true);
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(player.ship.boosting).toBe(false);
});

test.each(['dead', 'exploding', 'schematic'])(
  'right click cannot start boost while the pilot is %s',
  (state) => {
    if (state === 'dead') {
      player.lives = 0;
    }
    if (state === 'exploding') {
      player.ship.exploding = true;
    }
    if (state === 'schematic') {
      setShipSchematicOpen(true);
    }
    handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
    expect(player.ship.boosting).toBe(false);
  }
);

test('a synthetic touch right-click cannot toggle boost', () => {
  const ev = new MouseEvent('mousedown', { button: 2 });
  Object.defineProperty(ev, 'sourceCapabilities', {
    value: { firesTouchEvents: true },
  });
  handleMouseDown(ev, player);
  expect(player.ship.boosting).toBe(false);
});

test('synthetic touch-mouse events do not steal the desktop bindings', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  const ev = new MouseEvent('mousedown', { button: 0 });
  Object.defineProperty(ev, 'sourceCapabilities', {
    value: { firesTouchEvents: true },
  });
  handleMouseDown(ev, player);
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.thrusting).toBe(true);
});
