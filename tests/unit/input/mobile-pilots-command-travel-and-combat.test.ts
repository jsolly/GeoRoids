import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { WeaponChargeAction } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { resetControlSources } from '../../../src/input/controlSources';

import {
  disposeTouchControls,
  initializeTouchControls,
  mountTouchActionControls,
  readActionControls,
  readTouchControlDiagnostics,
  tickTouchControls,
} from '../../../src/input/touchControls';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import {
  closeGameOverlay,
  getOpenGameOverlay,
  openGameOverlay,
} from '../../../src/runtime/overlayState';

let player: Player;
let canvas: HTMLCanvasElement;
let actions: { ability: HTMLButtonElement; contourLock: HTMLButtonElement };
let fire: HTMLButtonElement;
let disposeActions: () => void;
let touchMode = true;
const sendCharge = vi.fn<(action: WeaponChargeAction) => boolean>(() => true);

beforeAll(() => {
  const network = ConnectionManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

beforeEach(() => {
  resetControlSources();
  document.elementFromPoint = vi.fn(() => null);
  sendCharge.mockClear();
  player = new Player({
    id: 'touch-pilot',
    name: 'Pilot',
    type: 'local',
    combatNetwork: { isConnected: true, sendShoot: () => {}, sendAbility: () => true, sendCharge },
  });
  // Keep ordinary tool scenarios away from contextual furnace actions.
  player.ship.position = { x: 2_000, y: 0 };
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => false;
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 390, height: 844 });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 844));
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
  touchMode = true;
  initializeTouchControls({
    canvas,
    readInPlay: () => true,
    readTouchMode: () => touchMode,
    onActionState: () => {},
  });
  actions = {
    ability: document.createElement('button'),
    contourLock: document.createElement('button'),
  };
  document.body.append(actions.ability, actions.contourLock);
  fire = document.createElement('button');
  fire.setPointerCapture = vi.fn();
  document.body.append(fire);
  disposeActions = mountTouchActionControls({ ...actions, fire });
  document.body.classList.add('in-play', 'touch-play');
  tickTouchControls(player);
});

afterEach(() => {
  const overlay = getOpenGameOverlay();
  if (overlay) {
    closeGameOverlay(overlay);
  }
  window.dispatchEvent(new Event('blur'));
  document.body.classList.remove('in-play', 'touch-play');
  disposeActions();
  disposeTouchControls();
  actions.ability.remove();
  actions.contourLock.remove();
  canvas.remove();
  fire.remove();
  vi.useRealTimers();
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

test('a playfield tap orders travel without firing or holding a finger', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointerup', 1, 100);
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.navigation?.destination).toEqual({ x: 1865, y: -122 });
  tickTouchControls(player);
  player.ship.update();
  expect(player.ship.navigation).not.toBeNull();
  expect(player.ship.position).not.toEqual({ x: 2000, y: 0 });
});

test('small finger movement remains a tap and a second tap replaces the destination', () => {
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 40, 63, 303);
  pointer('pointerup', 1, 100, 63, 303);
  const first = player.ship.navigation?.destination;
  pointer('pointerdown', 2, 200, 300, 600);
  pointer('pointerup', 2, 300, 300, 600);
  expect(player.ship.navigation?.destination).not.toEqual(first);
});

test('a quick Fire tap shoots once and never sets a destination', () => {
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0, 20, 20, fire);
  pointer('pointerup', 1, 100, 20, 20, fire);
  expect(shoot).toHaveBeenCalledTimes(1);
  expect(sendCharge).not.toHaveBeenCalled();
  expect(player.ship.navigation).toBeNull();
});

test('holding Fire charges and release fires the charged beam without a normal shot', () => {
  vi.useFakeTimers();
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0, 20, 20, fire);
  vi.advanceTimersByTime(220);
  expect(sendCharge).toHaveBeenCalledWith('start');
  expect(shoot).not.toHaveBeenCalled();
  pointer('pointerup', 1, 500, 20, 20, fire);
  expect(sendCharge.mock.calls.map((c) => c[0])).toEqual(['start', 'release']);
});

test('a Fire drag cancels travel and aims while charging', () => {
  vi.useFakeTimers();
  pointer('pointerdown', 1, 0);
  pointer('pointerup', 1, 100);
  pointer('pointerdown', 2, 200, 20, 20, fire);
  pointer('pointermove', 2, 250, 100, 20, fire);
  vi.advanceTimersByTime(220);
  tickTouchControls(player);
  expect(player.ship.navigation).toBeNull();
  expect(player.ship.angularVelocity).toBeLessThan(0);
  pointer('pointerup', 2, 500, 100, 20, fire);
  expect(sendCharge).toHaveBeenLastCalledWith('release');
});

test('two playfield fingers activate one shield, consume both taps, and preserve travel', () => {
  const shield = vi.spyOn(player.ship, 'activateShield');
  pointer('pointerdown', 1, 0);
  pointer('pointerup', 1, 100);
  const order = player.ship.navigation;
  pointer('pointerdown', 2, 200);
  pointer('pointerdown', 3, 220, 250, 500);
  pointer('pointerup', 2, 250);
  pointer('pointerup', 3, 260, 250, 500);
  expect(shield).toHaveBeenCalledTimes(1);
  expect(player.ship.navigation).toBe(order);
  expect(readActionControls(player).menu).toBeNull();
});

test('a Fire finger plus a destination finger never activates the shield', () => {
  const shield = vi.spyOn(player.ship, 'activateShield');
  pointer('pointerdown', 1, 0, 20, 20, fire);
  pointer('pointerdown', 2, 20);
  pointer('pointerup', 2, 100);
  pointer('pointerup', 1, 120, 20, 20, fire);
  expect(shield).not.toHaveBeenCalled();
  expect(player.ship.navigation).not.toBeNull();
});

test('long press opens actions without redirecting or firing; second finger cancels it', () => {
  vi.useFakeTimers();
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  vi.advanceTimersByTime(450);
  expect(readActionControls(player).menu?.actions.map((a) => a.action)).toEqual(['fly', 'signal']);
  pointer('pointerup', 1, 500);
  expect(player.ship.navigation).toBeNull();
  expect(shoot).not.toHaveBeenCalled();
  pointer('pointerdown', 2, 600);
  vi.advanceTimersByTime(450);
  pointer('pointerdown', 3, 1100, 250, 500);
  expect(readActionControls(player).menu).toBeNull();
});

test('an ordinary swipe triggers one equipped ability without movement or firing', () => {
  const ability = vi.spyOn(player.ship, 'activateAbility');
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 70, 140, 300);
  pointer('pointerup', 1, 100, 140, 300);
  expect(ability).toHaveBeenCalledTimes(1);
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.navigation).toBeNull();
});

test('a contour swipe hops instead of using the equipped ability', () => {
  player.ship.contourLock = { height: 0, direction: 1 };
  const hop = vi.spyOn(player.ship, 'hopContour').mockReturnValue(true);
  const ability = vi.spyOn(player.ship, 'activateAbility');
  pointer('pointerdown', 1, 0);
  pointer('pointermove', 1, 70, 140, 300);
  pointer('pointerup', 1, 100, 140, 300);
  expect(hop).toHaveBeenCalledWith({ x: 80, y: 0 });
  expect(ability).not.toHaveBeenCalled();
});

test.each([
  'blur',
  'pagehide',
  'hidden',
  'overlay',
  'death',
  'desktop',
  'detach',
  'dispose',
  'touchcancel',
])('%s cancels gestures, travel and charges without firing', (reason) => {
  vi.useFakeTimers();
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0);
  pointer('pointerup', 1, 100);
  pointer('pointerdown', 2, 200, 20, 20, fire);
  vi.advanceTimersByTime(220);
  if (reason === 'hidden') {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
  } else if (reason === 'overlay') {
    openGameOverlay('universe-map');
  } else if (reason === 'death') {
    player.ship.health = 0;
    tickTouchControls(player);
  } else if (reason === 'desktop') {
    touchMode = false;
    tickTouchControls(player);
  } else if (reason === 'detach') {
    disposeActions();
  } else if (reason === 'dispose') {
    disposeTouchControls();
  } else if (reason === 'touchcancel') {
    touchChange('touchcancel', []);
  } else {
    window.dispatchEvent(new Event(reason));
  }
  expect(sendCharge).toHaveBeenLastCalledWith('cancel');
  expect(shoot).not.toHaveBeenCalled();
  expect(player.ship.navigation).toBeNull();
  expect(readTouchControlDiagnostics().steerPointerHeld).toBe(false);
});

test('pointer cancellation discards a charge and cannot fire a normal shot', () => {
  vi.useFakeTimers();
  const shoot = vi.spyOn(player.ship, 'shoot');
  pointer('pointerdown', 1, 0, 20, 20, fire);
  vi.advanceTimersByTime(220);
  pointer('pointercancel', 1, 300, 20, 20, fire);
  expect(sendCharge).toHaveBeenLastCalledWith('cancel');
  expect(shoot).not.toHaveBeenCalled();
});
