import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { initializeTouchControls, tickTouchControls } from '../../../src/input/touchControls';
import { canvasManager } from '../../../src/rendering/canvas';

let player: Player;
let canvas: HTMLCanvasElement;

beforeEach(() => {
  resetControlSources();
  player = new Player({
    id: 'touch-pilot',
    name: 'Pilot',
    type: 'local',
    input: new MockPlayerInput(),
  });
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => false;
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 390, height: 844 });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 844));
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
  initializeTouchControls();
  document.body.classList.add('touch-play');
});

afterEach(() => {
  window.dispatchEvent(new Event('blur'));
  document.body.classList.remove('touch-play');
  canvas.remove();
  vi.restoreAllMocks();
});

function pointer(
  type: string,
  id: number,
  time: number,
  x = 60,
  y = 300,
  target: Element = canvas
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: 'touch' },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
}

test('a quick playfield tap fires once and leaves neither thrust nor fire held', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  const heading = player.ship.angle;
  pointer('pointerdown', 1, 0);
  expect(player.ship.thrusting).toBe(false);
  expect(player.ship.angle).toBe(heading);
  pointer('pointerup', 1, 100);
  expect(player.ship.angle).toBe(heading);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(player.ship.thrusting).toBe(false);
  expect(controlSources.touchFire).toBe(false);
});

test('a second finger fires while the first keeps its steering heading', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  const heading = player.ship.angle;
  pointer('pointerdown', 2, 50, 320, 400);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(player.ship.angle).toBe(heading);
  expect(player.ship.thrusting).toBe(true);
  tickTouchControls(player);
  expect(shoot).toHaveBeenCalledTimes(2);
  pointer('pointerup', 2, 100, 320, 400);
  expect(controlSources.touchFire).toBe(false);
  expect(player.ship.thrusting).toBe(true);
  pointer('pointerup', 1, 150);
  expect(shoot).toHaveBeenCalledTimes(2);
});

test('lifting the movement finger preserves held fire until the firing finger lifts', () => {
  pointer('pointerdown', 1, 0);
  pointer('pointerdown', 2, 50, 320, 400);
  pointer('pointerup', 1, 100);
  expect(player.ship.thrusting).toBe(false);
  expect(controlSources.touchFire).toBe(true);
  pointer('pointerup', 2, 150, 320, 400);
  expect(controlSources.touchFire).toBe(false);
});

test('dragging or holding the movement finger never creates a release shot', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 30, 100, 300);
  pointer('pointerup', 1, 100);
  pointer('pointerdown', 2, 200);
  pointer('pointerup', 2, 600);
  expect(shoot).not.toHaveBeenCalled();
});

test.each(['pointercancel', 'lostpointercapture'])(
  '%s cancels firing without releasing the steering finger',
  (type) => {
    pointer('pointerdown', 1, 0);
    pointer('pointerdown', 2, 50, 320, 400);
    pointer(type, 2, 100);
    expect(controlSources.touchFire).toBe(false);
    expect(player.ship.thrusting).toBe(true);
  }
);

test('an interrupted tap never fires, and losing focus clears both held fingers', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointercancel', 1, 30);
  expect(shoot).not.toHaveBeenCalled();
  pointer('pointerdown', 1, 100);
  pointer('pointerdown', 2, 150, 320, 400);
  window.dispatchEvent(new Event('blur'));
  expect(controlSources.touchFire).toBe(false);
  expect(player.ship.thrusting).toBe(false);
});

test('ability buttons do not create playfield shots or change steering', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  const ability = document.getElementById('touch-ability');
  expect(ability).toBeTruthy();
  if (!ability) {
    throw new Error('Missing ability button');
  }
  ability.setPointerCapture = vi.fn();
  ability.hasPointerCapture = () => false;
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  pointer('pointerdown', 2, 50, 320, 780, ability);
  pointer('pointerup', 2, 100, 320, 780, ability);
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.thrusting).toBe(true);
});

test('holding a finger starts steering, and release cancels a pending hold', () => {
  vi.useFakeTimers();
  try {
    pointer('pointerdown', 1, 0);
    expect(player.ship.thrusting).toBe(false);
    vi.advanceTimersByTime(250);
    expect(player.ship.thrusting).toBe(true);
    pointer('pointerup', 1, 300);
    expect(player.ship.thrusting).toBe(false);
    pointer('pointerdown', 2, 400);
    pointer('pointercancel', 2, 450);
    vi.advanceTimersByTime(250);
    expect(player.ship.thrusting).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('an action tap during a pending hold still lets a second canvas finger start steering and fire', () => {
  const ability = document.getElementById('touch-ability');
  if (!ability) {
    throw new Error('Missing ability button');
  }
  ability.setPointerCapture = vi.fn();
  ability.hasPointerCapture = () => false;
  pointer('pointerdown', 1, 0);
  pointer('pointerdown', 2, 30, 320, 780, ability);
  pointer('pointerup', 2, 50, 320, 780, ability);
  expect(player.ship.thrusting).toBe(false);
  pointer('pointerdown', 3, 80, 320, 400);
  expect(player.ship.thrusting).toBe(true);
  expect(controlSources.touchFire).toBe(true);
  pointer('pointerup', 3, 100, 320, 400);
  expect(controlSources.touchFire).toBe(false);
  expect(player.ship.thrusting).toBe(true);
});
