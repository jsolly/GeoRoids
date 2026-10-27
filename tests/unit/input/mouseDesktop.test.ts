import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import {
  keyDown,
  reconcilePlayerInput,
  togglePlayerContourLock,
} from '../../../src/input/keybindings';

import { handleMouseDown, handleMouseMove, preventContextMenu } from '../../../src/input/mouse';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { closeGameOverlay, openGameOverlay } from '../../../src/runtime/overlayState';

let player: Player;
let testCanvas: HTMLCanvasElement;

beforeEach(() => {
  resetControlSources();
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  testCanvas = document.createElement('canvas');
  document.body.appendChild(testCanvas);
  canvasManager.initialize(testCanvas);
  vi.spyOn(testCanvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
  player = new Player({
    id: 'mouse-desktop',
    name: 'Desk',
    type: 'local',
  });
  reconcilePlayerInput(player);
});

afterEach(() => {
  closeGameOverlay('inventory');
  canvasManager.destroy();
  testCanvas.remove();
  vi.unstubAllGlobals();
  resetControlSources();
  vi.restoreAllMocks();
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
  expect(player.ship.thrusting).toBe(false);
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

test('mouse movement turns the ship toward the cursor at a capped rate', () => {
  const canvas = canvasManager.getCanvas();
  expect(canvas).not.toBeNull();
  if (!canvas) {
    throw new Error('Canvas unavailable');
  }

  const viewport = canvasManager.getViewportSize();
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;

  // Move to the right of center => angle ~ 0
  const evRight = new MouseEvent('mousemove', { clientX: centerX + 50, clientY: centerY });
  handleMouseMove(evRight, player);
  expect(player.ship.angle).toBeCloseTo(Math.PI / 2);
  for (let frame = 0; frame < 20; frame++) {
    reconcilePlayerInput(player);
    player.ship.update();
  }
  expect(Math.abs(player.ship.angle)).toBeLessThan(1e-6);

  // Move above center => angle ~ +PI/2
  const evUp = new MouseEvent('mousemove', { clientX: centerX, clientY: centerY - 50 });
  handleMouseMove(evUp, player);
  expect(player.ship.angle).toBeCloseTo(0);
  for (let frame = 0; frame < 20; frame++) {
    reconcilePlayerInput(player);
    player.ship.update();
  }
  expect(Math.abs(player.ship.angle - Math.PI / 2)).toBeLessThan(1e-6);
});

test('left click fires once without interrupting cruise', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  handleMouseDown(new MouseEvent('mousedown', { button: 0 }), player);
  expect(shoot).toHaveBeenCalledOnce();
  expect(player.ship.canShoot).toBe(false);
  expect(player.ship.lasers).toHaveLength(1);
  expect(player.ship.thrusting).toBe(false);
});

test('right click toggles contour lock once per press without firing or interrupting cruise', () => {
  const toggle = vi.spyOn(player.ship, 'toggleContourLock').mockImplementation(() => {
    player.ship.contourLock = player.ship.contourLocked ? null : { height: 0.1, direction: 1 };
    return player.ship.contourLocked;
  });
  const shoot = vi.spyOn(player.ship, 'shoot');
  expect(player.ship.contourLocked).toBe(false);
  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(toggle).toHaveBeenCalledOnce();
  expect(player.ship.contourLocked).toBe(true);
  expect(player.ship.thrusting).toBe(false);
  expect(shoot).not.toHaveBeenCalled();

  handleMouseDown(new MouseEvent('mousedown', { button: 2 }), player);
  expect(toggle).toHaveBeenCalledTimes(2);
  expect(player.ship.contourLocked).toBe(false);
});

test('preventContextMenu prevents default on right click', () => {
  const ev = new MouseEvent('contextmenu');
  const preventDefault = vi.fn();
  ev.preventDefault = preventDefault;
  preventContextMenu(ev);
  expect(preventDefault).toHaveBeenCalled();
});
