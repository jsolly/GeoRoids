import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import {
  keyDown,
  reconcilePlayerInput,
  togglePlayerContourLock,
} from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { handleMouseDown, handleMouseMove, handleMouseUp } from '../../../src/input/mouse';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { closeGameOverlay, openGameOverlay } from '../../../src/runtime/overlayState';

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
  closeGameOverlay('inventory');
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

test('right click toggles contour lock without firing or interrupting cruise', () => {
  vi.spyOn(player.ship, 'toggleContourLock').mockImplementation(() => {
    player.ship.contourLock = player.ship.contourLocked ? null : { height: 0.1, direction: 1 };
    return player.ship.contourLocked;
  });
  const shoot = vi.spyOn(player.ship, 'shoot');
  expect(player.ship.contourLocked).toBe(false);
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(player.ship.contourLocked).toBe(true);
  expect(player.ship.thrusting).toBe(true);
  expect(shoot).not.toHaveBeenCalled();
  handleMouseUp(new MouseEvent('mouseup', { button: 2 }), player);
  expect(player.ship.contourLocked).toBe(true);
  expect(player.ship.thrusting).toBe(true);
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(player.ship.contourLocked).toBe(false);
});

test.each(['dead', 'exploding', 'schematic'])(
  'right click cannot start contour lock while the pilot is %s',
  (state) => {
    if (state === 'dead') {
      player.ship.health = 0;
    }
    if (state === 'exploding') {
      player.ship.exploding = true;
    }
    if (state === 'schematic') {
      openGameOverlay('inventory');
    }
    handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
    expect(player.ship.contourLocked).toBe(false);
  }
);

test('a synthetic touch right-click cannot toggle contour lock', () => {
  const ev = new MouseEvent('mousedown', { button: 2 });
  Object.defineProperty(ev, 'sourceCapabilities', {
    value: { firesTouchEvents: true },
  });
  handleMouseDown(ev, player);
  expect(player.ship.contourLocked).toBe(false);
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

test('locked steering keys are discarded until explicit release and a new press', () => {
  controlSources.pointerHeading = 1;
  player.ship.contourLock = { height: 0.1, direction: 1 };
  reconcilePlayerInput(player);
  expect(player.ship.angularVelocity).toBe(0);
  keyDown(new KeyboardEvent('keydown', { code: 'ArrowLeft', repeat: true }), player);
  keyDown(new KeyboardEvent('keydown', { code: 'ArrowRight' }), player);
  expect(player.ship.contourLocked).toBe(true);
  togglePlayerContourLock(player);
  reconcilePlayerInput(player);
  expect(player.ship.contourLocked).toBe(false);
  expect(controlSources.pointerHeading).toBeNull();
  expect(player.ship.angularVelocity).toBe(0);
  keyDown(new KeyboardEvent('keydown', { code: 'ArrowRight', repeat: true }), player);
  reconcilePlayerInput(player);
  expect(player.ship.angularVelocity).toBe(0);
  keyDown(new KeyboardEvent('keydown', { code: 'ArrowRight' }), player);
  expect(player.ship.angularVelocity).not.toBe(0);
});

test('pointer steering is ignored on the rail while firing remains available', () => {
  player.ship.contourLock = { height: 0.1, direction: 1 };
  const shoot = vi.spyOn(player.ship, 'shoot');
  handleMouseDown(new MouseEvent('mousedown', { button: 0 }), player);
  expect(shoot).toHaveBeenCalledTimes(1);
  const canvas = document.createElement('canvas');
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
  handleMouseMove(new MouseEvent('mousemove', { clientX: 700, clientY: 200 }), player);
  expect(player.ship.contourLocked).toBe(true);
  expect(controlSources.pointerHeading).toBeNull();
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(player.ship.contourLocked).toBe(false);
  expect(controlSources.pointerHeading).toBeNull();
});
