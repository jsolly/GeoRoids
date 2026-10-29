import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import ActionControls from '../../../src/components/game/ActionControls.svelte';
import { GameStateManager } from '../../../src/core/services/GameStateManager';
import { InputManager } from '../../../src/core/services/InputManager';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { getPressedKeysForPlayer } from '../../../src/input/keybindings';

import {
  disposeTouchControls,
  initializeTouchControls,
  mountTouchActionControls,
  readActionControls,
  tickTouchControls,
} from '../../../src/input/touchControls';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { resetWorldExploration, setWorldMapAssets } from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { setPlayView } from '../../../src/ui/uiUtils';

let panel: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
beforeAll(() => {
  const network = ConnectionManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});
afterEach(async () => {
  if (panel) {
    await unmount(panel);
  }
  panel = undefined;
  disposeTouchControls();
  resetWorldExploration();
  target?.remove();
  vi.restoreAllMocks();
  document.body.classList.remove('in-play', 'touch-play');
});

function start(touchMode = true) {
  target = document.createElement('div');
  document.body.append(target);
  const player = new Player({
    id: 'control-pilot',
    name: 'Pilot',
    type: 'local',
  });
  player.ship.position = { x: 2_000, y: 0 };
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
  const canvas = document.createElement('canvas');
  target.append(canvas);
  const view = writable(readActionControls(null));
  const state = fromStore(view);
  let inPlay = true;
  initializeTouchControls({
    canvas,
    readInPlay: () => inPlay,
    readTouchMode: () => touchMode,
    onActionState: () => view.set(readActionControls(player)),
  });
  panel = mount(ActionControls, {
    target,
    props: {
      get view() {
        return state.current;
      },
      mountActions: mountTouchActionControls,
    },
  });
  flushSync();
  return {
    player,
    refresh: () => {
      view.set(readActionControls(player));
      flushSync();
    },
    leave: () => {
      inPlay = false;
      setPlayView(false);
      flushSync();
    },
  };
}

function ability(): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>('#touch-ability');
  if (!button) {
    throw new Error('Missing ability');
  }
  return button;
}
function contour(): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>('#touch-contour-lock');
  if (!button) {
    throw new Error('Missing contour lock');
  }
  return button;
}

test('O opens visible-object actions on desktop, cycles targets and returns keyboard focus', () => {
  const { player } = start(false);
  const canvas = target.querySelector('canvas');
  if (!canvas) {
    throw new Error('Missing playfield');
  }
  canvas.tabIndex = 0;
  canvas.focus();
  player.ship.position = { x: 300, y: 0 };
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 800, height: 600 });
  vi.spyOn(canvasManager, 'readInputScale').mockReturnValue(1);
  setWorldMapAssets([
    {
      id: 'furnace:street-1-0',
      kind: 'foundation',
      name: 'Test foundation',
      position: { x: 320, y: 0 },
    },
  ]);
  const open = () => {
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }));
    tickTouchControls(player);
    flushSync();
  };
  open();
  const menu = target.querySelector('.object-menu');
  expect(menu).not.toBeNull();
  expect(menu?.contains(document.activeElement)).toBe(true);
  const initial = menu?.getAttribute('aria-label');
  const next = menu?.querySelector('button');
  next?.click();
  flushSync();
  expect(menu?.getAttribute('aria-label')).not.toBe(initial);
  const inspect = target.querySelector<HTMLButtonElement>('[data-object-action="inspect"]');
  expect(inspect).not.toBeNull();
  inspect?.click();
  flushSync();
  expect(target.querySelector('.travel-status')?.textContent).toContain('Town Square');
  expect(document.activeElement).toBe(canvas);
  open();
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })
  );
  flushSync();
  expect(target.querySelector('.object-menu')).toBeNull();
  expect(document.activeElement).toBe(canvas);
});

test('setPlayView announces play chrome so the overlay can appear', () => {
  const on = vi.fn();
  const off = vi.fn();
  window.addEventListener('playViewOn', on);
  window.addEventListener('playViewOff', off);
  setPlayView(true);
  expect(on).toHaveBeenCalledTimes(1);
  setPlayView(false);
  expect(off).toHaveBeenCalledTimes(1);
  window.removeEventListener('playViewOn', on);
  window.removeEventListener('playViewOff', off);
});

test.each([true, false])(
  'touch mode %s shows only its action chrome and leaving play hides all actions',
  (touchMode) => {
    const { leave } = start(touchMode);
    expect(target.querySelector<HTMLElement>('#touch-controls')?.hidden).toBe(false);
    expect(ability().hidden).toBe(!touchMode);
    expect(ability().tagName).toBe('BUTTON');
    expect(ability().type).toBe('button');
    expect(ability().getAttribute('aria-label')).toBeTruthy();
    expect(contour().tagName).toBe('BUTTON');
    expect(contour().textContent).toBe('CONTOUR LOCK');
    expect(target.querySelector<HTMLButtonElement>('.touch-shield')?.hidden).toBe(!touchMode);
    expect(contour().hidden).toBe(false);
    expect(target.querySelector('#touch-stick')).toBeNull();
    expect(target.querySelector<HTMLButtonElement>('.touch-fire')?.hidden).toBe(!touchMode);
    leave();
    expect(target.querySelector<HTMLElement>('#touch-controls')?.hidden).toBe(true);
  }
);

test('Contour Lock explains unavailable, ready and releasable states through the mounted Button', () => {
  const { player, refresh } = start();
  const eligible = vi.spyOn(player.ship, 'canLockContour').mockReturnValue(false);
  refresh();
  expect(contour().disabled).toBe(true);
  expect(contour().getAttribute('aria-label')).toContain('approach a contour');
  eligible.mockReturnValue(true);
  refresh();
  expect(contour().disabled).toBe(false);
  player.ship.contourLock = { height: 0.16, direction: 1 };
  eligible.mockReturnValue(false);
  refresh();
  expect(contour().textContent).toBe('RELEASE LOCK');
  expect(contour().getAttribute('aria-pressed')).toBe('true');
  expect(contour().disabled).toBe(false);
  player.ship.releaseContourLock();
  refresh();
  expect(contour().getAttribute('aria-pressed')).toBe('false');
  expect(contour().disabled).toBe(true);
});

test('ability cooldown, immediate pointer press and semantic clicks update the same mounted button', () => {
  const { player, refresh } = start();
  const button = ability();
  const captures = new Set<number>();
  button.setPointerCapture = (id) => {
    captures.add(id);
  };
  button.hasPointerCapture = (id) => captures.has(id);
  button.releasePointerCapture = (id) => {
    captures.delete(id);
  };
  const activate = vi.spyOn(player.ship, 'activateAbility').mockReturnValue(true);
  const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperty(press, 'pointerId', { value: 1 });
  button.dispatchEvent(press);
  flushSync();
  expect(button.classList.contains('is-pressed')).toBe(true);
  expect(activate).toHaveBeenCalledTimes(1);
  const release = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
  Object.defineProperty(release, 'pointerId', { value: 1 });
  button.dispatchEvent(release);
  flushSync();
  expect(button.classList.contains('is-pressed')).toBe(false);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(activate).toHaveBeenCalledTimes(1);
  button.click();
  expect(activate).toHaveBeenCalledTimes(2);
  player.ship.abilityCooldownFrames = 90;
  refresh();
  expect(button.classList.contains('is-cooling')).toBe(true);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(Number(button.style.getPropertyValue('--action-cool'))).toBeGreaterThan(0);
  expect(ability()).toBe(button);
});

test.each(['action button', 'details summary'])(
  'Space on %s does not fire the ship and keyup still clears held input',
  (control) => {
    const { player, refresh } = start(false);
    vi.spyOn(player.ship, 'canLockContour').mockReturnValue(true);
    refresh();
    const shoot = vi.spyOn(player.ship, 'shoot').mockImplementation(() => undefined);
    GameStateManager.getInstance().setIsGameRunning(true);
    const manager = InputManager.getInstance();
    const inputCanvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
    if (!inputCanvas) {
      throw new Error('Input fixture requires its canvas');
    }
    manager.initializeListeners(inputCanvas);
    try {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Device and conditions';
      details.append(summary);
      target.append(details);
      const focused = control === 'action button' ? contour() : summary;
      focused.focus();
      const key = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
      focused.dispatchEvent(key);
      expect(shoot).not.toHaveBeenCalled();
      expect(getPressedKeysForPlayer(player).has('Space')).toBe(false);
      expect(key.defaultPrevented).toBe(false);
      getPressedKeysForPlayer(player).add('Space');
      focused.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
      expect(getPressedKeysForPlayer(player).has('Space')).toBe(false);
    } finally {
      manager.detachRuntime();
      GameStateManager.getInstance().setIsGameRunning(false);
    }
  }
);
