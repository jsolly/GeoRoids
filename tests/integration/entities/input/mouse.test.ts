import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '../../../../src/constants/user-preferences';
import { Player } from '../../../../src/entities/player/Player';
import { resetControlSources } from '../../../../src/input/controlSources';
import { reconcilePlayerInput } from '../../../../src/input/keybindings';
import { MockPlayerInput } from '../../../../src/input/MockPlayerInput';
import {
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  preventContextMenu,
} from '../../../../src/input/mouse';
import { canvasManager } from '../../../../src/rendering/canvas';

let player: Player;
let testCanvas: HTMLCanvasElement;

beforeEach(() => {
  resetControlSources();
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
  // Set predictable viewport size used by canvasManager.initialize()
  Object.defineProperty(window, 'innerWidth', { value: 800, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 600, writable: true });

  // Create and mount a canvas element so canvasManager can find it
  testCanvas = document.createElement('canvas');
  document.body.appendChild(testCanvas);

  // Initialize canvas manager
  canvasManager.initialize();

  // JSDOM layout: mock bounding rect to align with (0,0)
  // Set mock after canvasManager.initialize() to ensure it works
  const canvas = canvasManager.getCanvas();
  if (canvas) {
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }

  player = new Player({ id: 'p1', name: 'Tester', type: 'local', input: new MockPlayerInput() });
  reconcilePlayerInput(player);
});

afterEach(() => {
  resetControlSources();
  // Perform DOM-safe cleanup by removing only the test canvas
  if (testCanvas?.parentNode) {
    testCanvas.parentNode.removeChild(testCanvas);
  }

  vi.resetAllMocks();
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
  expect(Math.abs(player.ship.angle - 0)).toBeLessThan(1e-6);

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

test('left click fires shoot() and release resets canShoot', () => {
  const shootSpy = vi.spyOn(player.ship, 'shoot');
  const down = new MouseEvent('mousedown', { button: 0 });
  handleMouseDown(down, player);
  expect(shootSpy).toHaveBeenCalled();
  player.ship.canShoot = false;
  const up = new MouseEvent('mouseup', { button: 0 });
  handleMouseUp(up, player);
  expect(player.ship.canShoot).toBeTruthy();
});

test('right click is unbound and does not interrupt automatic thrust', () => {
  const down = new MouseEvent('mousedown', { button: 2 });
  handleMouseDown(down, player);
  expect(player.ship.thrusting).toBeTruthy();

  const up = new MouseEvent('mouseup', { button: 2 });
  handleMouseUp(up, player);
  expect(player.ship.thrusting).toBeTruthy();
});

test('preventContextMenu prevents default on right click', () => {
  const ev = new MouseEvent('contextmenu');
  const preventDefault = vi.fn();
  ev.preventDefault = preventDefault;
  preventContextMenu(ev);
  expect(preventDefault).toHaveBeenCalled();
});
