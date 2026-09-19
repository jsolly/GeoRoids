import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { initializeTouchControls, tickTouchControls } from '../../../src/input/touchControls';
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
