import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { civicLot } from '../../../shared/furnaces';
import FieldHints from '../../../src/components/game/FieldHints.svelte';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { resetControlSources } from '../../../src/input/controlSources';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  disposeTouchControls,
  initializeTouchControls,
  readTouchControlDiagnostics,
} from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { resetWorldExploration } from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { closeGameOverlay, getOpenGameOverlay } from '../../../src/runtime/overlayState';
import * as townStore from '../../../src/runtime/townStore';
import { SCOUT_ONLY_BUILD_HINT } from '../../../src/ui/constants';
import {
  activateFieldHint,
  hideFieldHints,
  readFieldHints,
  setFieldHint,
  subscribeFieldHints,
} from '../../../src/ui/fieldHint';
import { syncFurnaceTravelPrompt } from '../../../src/ui/furnaceTravelPrompt';
import { setWindowViewport } from '../../support/viewport';

let component: ReturnType<typeof mount>;
let unsubscribe: () => void;
let restoreViewport: () => void;
let pilot: Player;
let canvas: HTMLCanvasElement;
beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});
beforeEach(() => {
  hideFieldHints();
  resetWorldExploration();
  resetControlSources();
  document.body.replaceChildren();
  document.body.classList.add('in-play');
  restoreViewport = setWindowViewport(390, 844);
  pilot = new Player({
    id: 'hint-pilot',
    name: 'Pilot',
    type: 'local',
    input: new MockPlayerInput(),
  });
  pilot.ship.position = { x: 0, y: 0 };
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(pilot);
  canvas = document.createElement('canvas');
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => false;
  document.body.append(canvas);
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 390, height: 844 });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 844));
  initializeTouchControls({
    canvas,
    readInPlay: () => true,
    readTouchMode: () => true,
    onActionState: () => {},
  });
  const model = writable(readFieldHints());
  const state = fromStore(model);
  unsubscribe = subscribeFieldHints(() => model.set(readFieldHints()));
  component = mount(FieldHints, {
    target: document.body,
    props: {
      get hints() {
        return state.current;
      },
      onactivate: activateFieldHint,
    },
  });
  flushSync();
});
afterEach(async () => {
  await unmount(component);
  unsubscribe();
  disposeTouchControls();
  hideFieldHints();
  const overlay = getOpenGameOverlay();
  if (overlay) {
    closeGameOverlay(overlay);
  }
  resetWorldExploration();
  resetControlSources();
  restoreViewport();
  vi.restoreAllMocks();
  document.body.classList.remove('in-play');
  document.body.replaceChildren();
});
function prompt() {
  const element = document.querySelector<HTMLButtonElement>('#furnace-travel-prompt button');
  if (!element) {
    throw new Error('Furnace prompt missing');
  }
  return element;
}
function pointer(type: string, target: Element, time: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 195,
    clientY: 500,
  });
  Object.defineProperties(event, {
    pointerId: { value: 82 },
    pointerType: { value: 'touch' },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
}

test('furnace prompt entry waits for the completed click and survives touch-end cleanup', () => {
  const openStore = vi.spyOn(townStore, 'openTownStore').mockReturnValue(true);
  const shoot = vi.spyOn(pilot.ship, 'shoot');
  syncFurnaceTravelPrompt();
  flushSync();
  const button = prompt();
  expect(button.textContent).toBe('Enter');
  pointer('pointerdown', button, 0);
  pointer('pointerup', button, 10);
  const touchend = new Event('touchend', { bubbles: true });
  Object.defineProperties(touchend, {
    touches: { value: [] },
    targetTouches: { value: [] },
    changedTouches: { value: [] },
  });
  canvas.dispatchEvent(touchend);
  expect(openStore).not.toHaveBeenCalled();
  expect(shoot).not.toHaveBeenCalled();
  expect(readTouchControlDiagnostics().liveTouches).toBe(0);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(openStore).toHaveBeenCalledExactlyOnceWith();
});

test('a boarding click rechecks the ship footprint and hidden hints retire commands before DOM updates', () => {
  const openStore = vi.spyOn(townStore, 'openTownStore').mockReturnValue(true);
  syncFurnaceTravelPrompt();
  flushSync();
  const button = prompt();
  button.focus();
  pointer('pointerdown', button, 0);
  pilot.ship.position = { x: 20_000, y: 20_000 };
  button.click();
  expect(openStore).not.toHaveBeenCalled();
  syncFurnaceTravelPrompt();
  pilot.ship.position = { x: 0, y: 0 };
  // A click queued before Svelte removes the old marker must not run the retired command.
  button.click();
  expect(openStore).not.toHaveBeenCalled();
  flushSync();
  expect(document.querySelector('#furnace-travel-prompt')).toBeNull();
  expect(document.activeElement).not.toBe(button);
  button.click();
  expect(openStore).not.toHaveBeenCalled();
});

test('the announcer precedes the first hint and keyboard activation cannot bubble into gameplay', () => {
  const announcer = document.querySelector('[role="status"]');
  expect(announcer?.textContent).toBe('');
  const first = vi.fn();
  const latest = vi.fn();
  setFieldHint('furnace-travel-prompt', true, { action: { label: 'Enter', run: first } });
  flushSync();
  const button = prompt();
  expect(document.querySelector('[role="status"]')).toBe(announcer);
  expect(announcer?.textContent).toBe('Enter');
  const keys = vi.fn();
  const scope = new AbortController();
  document.addEventListener('keydown', keys, { signal: scope.signal });
  document.addEventListener('keyup', keys, { signal: scope.signal });
  for (const code of ['Space', 'Enter']) {
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  }
  scope.abort();
  expect(keys).not.toHaveBeenCalled();
  setFieldHint('furnace-travel-prompt', true, { action: { label: 'Enter', run: latest } });
  button.click();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
  hideFieldHints();
  flushSync();
  expect(announcer?.textContent).toBe('');
});

test('a dark furnace explains Hauler and Scout requirements and removes the hint when building becomes affordable', () => {
  const lot = civicLot('street-2-0');
  if (!lot) {
    throw new Error('Missing dark furnace');
  }
  pilot.ship.kitId = 'hauler';
  pilot.ship.position = { x: lot.position.x + lot.radius - 5, y: lot.position.y };
  syncFurnaceTravelPrompt();
  flushSync();
  expect(document.querySelector('#furnace-build-hint')?.textContent).toBe(SCOUT_ONLY_BUILD_HINT);
  expect(document.querySelector('#furnace-build-hint button')).toBeNull();
  expect(document.querySelector('#furnace-build-hint span')?.getAttribute('aria-hidden')).toBe(
    'true'
  );
  expect(document.querySelector('[role="status"]')?.textContent).toBe(SCOUT_ONLY_BUILD_HINT);
  pilot.ship.position = { x: lot.position.x + lot.radius + 40, y: lot.position.y };
  syncFurnaceTravelPrompt();
  flushSync();
  expect(document.querySelector('#furnace-build-hint')).toBeNull();
  pilot.ship.position = { ...lot.position };
  pilot.ship.kitId = 'scout';
  for (const remaining of [25, 1, 0]) {
    pilot.score = lot.cost - remaining;
    syncFurnaceTravelPrompt();
    flushSync();
    expect(document.querySelector('#furnace-build-hint')?.textContent ?? null).toBe(
      remaining === 0
        ? null
        : `You need ${remaining} more ${remaining === 1 ? 'point' : 'points'} to build this furnace`
    );
  }
});
