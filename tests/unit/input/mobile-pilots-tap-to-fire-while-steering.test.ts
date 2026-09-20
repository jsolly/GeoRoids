import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  initializeTouchControls,
  readTouchControlDiagnostics,
  tickTouchControls,
} from '../../../src/input/touchControls';
import { canvasManager } from '../../../src/rendering/canvasSurface';

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
  document.body.classList.add('in-play', 'touch-play');
  tickTouchControls(player);
});

afterEach(() => {
  window.dispatchEvent(new Event('blur'));
  document.body.classList.remove('in-play', 'touch-play');
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

function touchChange(
  type: 'touchstart' | 'touchend' | 'touchcancel',
  remaining: Array<{ id: number; x?: number; y?: number }>
): void {
  const touches = remaining.map((point) => ({
    identifier: point.id,
    clientX: point.x ?? 60,
    clientY: point.y ?? 300,
    target: canvas,
  }));
  const list = Object.assign(touches, {
    item: (index: number) => touches[index] ?? null,
  });
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: list },
    targetTouches: { value: list },
    changedTouches: { value: list },
  });
  canvas.dispatchEvent(event);
}

test('a quick playfield tap fires once while cruise continues', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  const heading = player.ship.angle;
  pointer('pointerdown', 1, 0);
  expect(player.ship.thrusting).toBe(true);
  expect(player.ship.angle).toBe(heading);
  pointer('pointerup', 1, 100);
  expect(player.ship.angle).toBe(heading);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(player.ship.thrusting).toBe(true);
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
  expect(player.ship.thrusting).toBe(true);
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
  expect(player.ship.thrusting).toBe(true);
});

test('ability buttons do not create playfield shots or change steering', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  const ability = document.querySelector('#touch-ability');
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

test('Boost tap starts a stronger cruise and a second tap returns to cruise', () => {
  const boost = document.querySelector('#touch-boost');
  expect(boost).toBeTruthy();
  if (!boost) {
    throw new Error('Missing boost button');
  }
  boost.setPointerCapture = vi.fn();
  boost.hasPointerCapture = () => false;
  expect(player.ship.boosting).toBe(false);
  pointer('pointerdown', 1, 0, 195, 780, boost);
  pointer('pointerup', 1, 80, 195, 780, boost);
  expect(player.ship.boosting).toBe(true);
  expect(boost.getAttribute('aria-pressed')).toBe('true');
  pointer('pointerdown', 2, 200, 195, 780, boost);
  pointer('pointerup', 2, 280, 195, 780, boost);
  expect(player.ship.boosting).toBe(false);
  expect(boost.getAttribute('aria-pressed')).toBe('false');
});

test('a delayed pointer click cannot repeat an ability, while a following semantic click still works', () => {
  vi.useFakeTimers();
  try {
    const activate = vi.spyOn(player.ship, 'activateAbility').mockReturnValue(true);
    const ability = document.querySelector<HTMLButtonElement>('#touch-ability');
    if (!ability) {
      throw new Error('Missing ability button');
    }
    ability.setPointerCapture = vi.fn();
    ability.hasPointerCapture = () => false;
    pointer('pointerdown', 1, 0, 320, 780, ability);
    pointer('pointerup', 1, 100, 320, 780, ability);
    expect(activate).toHaveBeenCalledTimes(1);
    ability.click();
    expect(activate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    ability.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(activate).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('holding a finger starts steering, and release cancels its target without stopping cruise', () => {
  vi.useFakeTimers();
  try {
    pointer('pointerdown', 1, 0);
    expect(player.ship.thrusting).toBe(true);
    expect(controlSources.pointerHeading).toBeNull();
    vi.advanceTimersByTime(250);
    expect(controlSources.pointerHeading).not.toBeNull();
    expect(player.ship.thrusting).toBe(true);
    pointer('pointerup', 1, 300);
    expect(controlSources.pointerHeading).toBeNull();
    expect(player.ship.thrusting).toBe(true);
    pointer('pointerdown', 2, 400);
    pointer('pointercancel', 2, 450);
    vi.advanceTimersByTime(250);
    expect(controlSources.pointerHeading).toBeNull();
    expect(player.ship.thrusting).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('an action tap during a pending hold still lets a second canvas finger start steering and fire', () => {
  const ability = document.querySelector('#touch-ability');
  if (!ability) {
    throw new Error('Missing ability button');
  }
  ability.setPointerCapture = vi.fn();
  ability.hasPointerCapture = () => false;
  pointer('pointerdown', 1, 0);
  pointer('pointerdown', 2, 30, 320, 780, ability);
  pointer('pointerup', 2, 50, 320, 780, ability);
  expect(player.ship.thrusting).toBe(true);
  pointer('pointerdown', 3, 80, 320, 400);
  expect(player.ship.thrusting).toBe(true);
  expect(controlSources.touchFire).toBe(true);
  pointer('pointerup', 3, 100, 320, 400);
  expect(controlSources.touchFire).toBe(false);
  expect(player.ship.thrusting).toBe(true);
});

test('resting on a grown hull cancels the target and tiny finger jitter cannot whip the nose', () => {
  player.ship.r = 33;
  pointer('pointerdown', 1, 0, 295, 422);
  pointer('pointermove', 1, 20, 300, 402);
  expect(controlSources.pointerHeading).not.toBeNull();
  for (const [x, y] of [
    [195, 422],
    [197, 420],
    [193, 424],
    [225, 422],
  ]) {
    pointer('pointermove', 1, 40, x, y);
    expect(controlSources.pointerHeading).toBeNull();
    expect(player.ship.angularVelocity).toBe(0);
    expect(player.ship.thrusting).toBe(true);
  }
  pointer('pointerup', 1, 300, 195, 422);
});

test('lifting every reported finger clears a reserved steering pointer so cruise keeps the last heading', () => {
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  expect(readTouchControlDiagnostics()).toMatchObject({
    steerPointerHeld: true,
    pointerHeading: expect.any(Number),
    liveTouches: null,
  });
  touchChange('touchstart', [{ id: 1, x: 60, y: 270 }]);
  expect(readTouchControlDiagnostics().liveTouches).toBe(1);
  touchChange('touchend', []);
  expect(readTouchControlDiagnostics()).toMatchObject({
    steerPointerHeld: false,
    pointerHeading: null,
    touchFire: false,
    liveTouches: 0,
  });
  expect(player.ship.thrusting).toBe(true);
});

test('a dropped steering finger lets the next single-finger drag turn again instead of only firing', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  const firstHeading = controlSources.pointerHeading;
  expect(firstHeading).not.toBeNull();
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(true);

  touchChange('touchstart', [{ id: 7, x: 300, y: 200 }]);
  pointer('pointerdown', 7, 400, 300, 200);
  expect(controlSources.touchFire).toBe(false);
  expect(shoot).not.toHaveBeenCalled();
  pointer('pointermove', 7, 420, 320, 160);
  expect(controlSources.pointerHeading).not.toBeNull();
  expect(controlSources.pointerHeading).not.toBe(firstHeading);
  expect(readTouchControlDiagnostics()).toMatchObject({
    steerPointerHeld: true,
    touchFire: false,
    liveTouches: 1,
  });
  expect(player.ship.thrusting).toBe(true);
});

test('losing pointer capture while a finger is still reported keeps the steering heading', () => {
  touchChange('touchstart', [{ id: 1 }]);
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  const heading = controlSources.pointerHeading;
  pointer('lostpointercapture', 1, 40);
  expect(controlSources.pointerHeading).toBe(heading);
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(true);
  expect(player.ship.thrusting).toBe(true);
});

test('two live fingers still let the second tap fire while the first keeps steering', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  touchChange('touchstart', [{ id: 1 }]);
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  const heading = controlSources.pointerHeading;
  touchChange('touchstart', [
    { id: 1, x: 60, y: 270 },
    { id: 2, x: 320, y: 400 },
  ]);
  pointer('pointerdown', 2, 50, 320, 400);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(controlSources.pointerHeading).toBe(heading);
  expect(controlSources.touchFire).toBe(true);
  expect(readTouchControlDiagnostics().liveTouches).toBe(2);
});

test('a second pointerdown still fires when the live list has not yet added that finger', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  touchChange('touchstart', [{ id: 1, x: 60, y: 270 }]);
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  const heading = controlSources.pointerHeading;
  pointer('pointerdown', 2, 50, 320, 400);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(controlSources.touchFire).toBe(true);
  expect(controlSources.pointerHeading).toBe(heading);
  expect(readTouchControlDiagnostics().liveTouches).toBe(1);
});

test('a Chromium pointer id that does not match the touch identifier still lets the second finger fire', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  touchChange('touchstart', [
    { id: 11, x: 60, y: 300 },
    { id: 12, x: 320, y: 400 },
  ]);
  pointer('pointerdown', 3, 0, 60, 300);
  pointer('pointermove', 3, 10, 60, 270);
  const heading = controlSources.pointerHeading;
  expect(heading).not.toBeNull();
  pointer('pointerdown', 4, 50, 320, 400);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(controlSources.touchFire).toBe(true);
  expect(controlSources.pointerHeading).toBe(heading);
  expect(readTouchControlDiagnostics().liveTouches).toBe(2);
});

test('putting the thumb back near the last heading reclaims steer instead of only firing', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  touchChange('touchstart', [{ id: 1, x: 60, y: 270 }]);
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 10, 60, 270);
  const firstHeading = controlSources.pointerHeading;
  expect(firstHeading).not.toBeNull();

  // iOS can replace the reserved id without an empty touch list in between.
  touchChange('touchstart', [{ id: 8, x: 70, y: 280 }]);
  pointer('pointerdown', 8, 400, 70, 280);
  expect(controlSources.touchFire).toBe(false);
  expect(shoot).not.toHaveBeenCalled();
  pointer('pointermove', 8, 420, 120, 180);
  expect(controlSources.pointerHeading).not.toBeNull();
  expect(controlSources.pointerHeading).not.toBe(firstHeading);
  expect(readTouchControlDiagnostics()).toMatchObject({
    steerPointerHeld: true,
    touchFire: false,
    liveTouches: 1,
  });
});

test('after iPhone drops steer capture, the other finger keeps firing and a nearby thumb then steers again', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  touchChange('touchstart', [{ id: 11, x: 60, y: 300 }]);
  pointer('pointerdown', 3, 0, 60, 300);
  pointer('pointermove', 3, 10, 60, 270);
  const heading = controlSources.pointerHeading;
  expect(heading).not.toBeNull();

  touchChange('touchstart', [
    { id: 11, x: 60, y: 270 },
    { id: 12, x: 320, y: 400 },
  ]);
  pointer('lostpointercapture', 3, 40);
  expect(controlSources.pointerHeading).toBe(heading);
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(true);

  pointer('pointerdown', 4, 50, 320, 400);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(controlSources.touchFire).toBe(true);
  expect(controlSources.pointerHeading).toBe(heading);

  touchChange('touchstart', [{ id: 12, x: 320, y: 400 }]);
  pointer('pointerup', 4, 80, 320, 400);
  touchChange('touchstart', [{ id: 8, x: 70, y: 280 }]);
  pointer('pointerdown', 8, 120, 70, 280);
  expect(controlSources.touchFire).toBe(false);
  pointer('pointermove', 8, 140, 130, 160);
  expect(controlSources.pointerHeading).not.toBeNull();
  expect(controlSources.pointerHeading).not.toBe(heading);
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(true);
});

test('a nearby second finger keeps firing after the reserved steer id disappears, and the next thumb steers', () => {
  touchChange('touchstart', [{ id: 11, x: 60, y: 300 }]);
  pointer('pointerdown', 3, 0, 60, 300);
  pointer('pointermove', 3, 10, 60, 270);
  const heading = controlSources.pointerHeading;
  expect(heading).not.toBeNull();

  touchChange('touchstart', [
    { id: 11, x: 60, y: 270 },
    { id: 12, x: 80, y: 280 },
  ]);
  pointer('pointerdown', 4, 50, 80, 280);
  expect(controlSources.touchFire).toBe(true);
  expect(controlSources.pointerHeading).toBe(heading);

  touchChange('touchstart', [{ id: 12, x: 80, y: 280 }]);
  expect(controlSources.touchFire).toBe(true);
  expect(controlSources.pointerHeading).toBe(heading);
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(true);

  touchChange('touchstart', [
    { id: 12, x: 80, y: 280 },
    { id: 8, x: 50, y: 250 },
  ]);
  pointer('pointerdown', 8, 120, 50, 250);
  expect(controlSources.touchFire).toBe(true);
  pointer('pointermove', 8, 140, 130, 160);
  expect(controlSources.pointerHeading).not.toBeNull();
  expect(controlSources.pointerHeading).not.toBe(heading);
  expect(controlSources.touchFire).toBe(true);
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(true);
});
