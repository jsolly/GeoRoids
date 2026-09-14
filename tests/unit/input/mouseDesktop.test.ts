import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { resetControlSources } from '../../../src/input/controlSources';
import { reconcilePlayerInput } from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { handleMouseDown, handleMouseUp } from '../../../src/input/mouse';

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

test('right click is unbound while cruise and the fire binding stay unchanged', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(player.ship.thrusting).toBe(true);
  expect(shoot).not.toHaveBeenCalled();
  handleMouseUp(new MouseEvent('mouseup', { button: 2 }), player);
  expect(player.ship.thrusting).toBe(true);
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
