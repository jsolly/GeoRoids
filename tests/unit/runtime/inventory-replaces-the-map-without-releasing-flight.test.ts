import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GameController } from '../../../src/core/gameController';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { getPressedKeysForPlayer, keys } from '../../../src/input/keybindings';
import { NetworkManager } from '../../../src/network/networkManager';
import { createGameRuntime, type GameRuntime } from '../../../src/runtime/gameRuntime';
import { getOpenGameOverlay } from '../../../src/runtime/overlayState';
import type { GamePresentation } from '../../../src/runtime/uiTypes';

// Logging transport is external to the overlay and input owners under test.
vi.mock('../../../src/utils/logForwarder', () => ({
  startClientLogForwarder: vi.fn(),
  stopClientLogForwarder: vi.fn(),
  forwardLogToServer: vi.fn(),
}));

let runtime: GameRuntime | undefined;
let scope: AbortController;
let views: GamePresentation[];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function canvas(id: string): HTMLCanvasElement {
  const element = document.querySelector(`#${id}`);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`Missing canvas ${id}`);
  }
  return element;
}

beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.setItem('soundOn', 'false');
  localStorage.setItem('musicOn', 'false');
  frames.clear();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  const network = NetworkManager.getInstance();
  vi.spyOn(network, 'connect').mockResolvedValue();
  vi.spyOn(network, 'joinAndWaitForWorld').mockResolvedValue(true);
  vi.spyOn(network, 'getAllPlayers').mockReturnValue([]);
  document.body.innerHTML =
    '<main id="gameWrapper"><div id="gameArea"><canvas id="gameCanvas"></canvas><canvas id="spawn-fly-in"></canvas></div><canvas id="title-terrain"></canvas><canvas id="map-canvas"></canvas></main>';
  scope = new AbortController();
  runtime = createGameRuntime(
    {
      canvas: canvas('gameCanvas'),
      titleCanvas: canvas('title-terrain'),
      spawnCanvas: canvas('spawn-fly-in'),
      placeChrome: vi.fn(),
    },
    scope.signal
  );
  views = [];
  runtime.subscribe((view) => {
    views.push(view);
    // GameShell performs this body-mode projection in the mounted product.
    document.body.classList.toggle('in-play', view.inPlay);
  });
  runtime.commands.selectShip('hauler');
  runtime.commands.join('Overlay Pilot');
  for (let turn = 0; turn < 12; turn++) {
    await Promise.resolve();
  }
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
});

afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  scope.abort();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  document.body.classList.remove('in-play', 'touch-play', 'debug-on');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('switching from map to inventory cancels held controls without releasing the hull', () => {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player || !runtime) {
    throw new Error('Missing joined runtime');
  }
  player.ship.spawnProtectionTimer = 0;
  player.ship.blinkCount = 0;
  keys['Space'] = true;
  getPressedKeysForPlayer(player).add('KeyA');
  const shoot = vi.spyOn(player.ship, 'shoot').mockImplementation(() => {});
  runtime.commands.openUniverseMap();
  expect(getOpenGameOverlay()).toBe('universe-map');
  expect(views.at(-1)?.overlay).toBe('universe-map');
  const beforeMap = new Set(frames.keys());
  const chrome = vi.fn();
  const map = runtime.commands.mountUniverseMap(canvas('map-canvas'), chrome);
  const ownedMapFrames = [...frames.keys()].filter((id) => !beforeMap.has(id));
  expect(ownedMapFrames).toHaveLength(1);
  expect(chrome).toHaveBeenCalledOnce();
  expect(player.ship.movementLocked).toBe(true);
  expect(keys['Space']).toBe(false);
  expect(getPressedKeysForPlayer(player).size).toBe(0);
  document.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true, cancelable: true })
  );
  expect(getOpenGameOverlay()).toBe('inventory');
  expect(views.at(-1)?.overlay).toBe('inventory');
  expect(views.at(-1)?.inventory).not.toBeNull();
  for (const id of ownedMapFrames) {
    expect(frames.has(id)).toBe(false);
  }
  expect(player.ship.movementLocked).toBe(true);
  expect(player.ship.blinkCount).toBe(0);
  const fire = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
  document.dispatchEvent(fire);
  expect(fire.defaultPrevented).toBe(true);
  expect(shoot).not.toHaveBeenCalled();
  runtime.commands.closeInventory();
  expect(views.at(-1)?.overlay).toBeNull();
  expect(player.ship.movementLocked).toBe(false);
  expect(player.ship.blinkCount).toBeGreaterThan(0);
  map.dispose();
});

test('editable fields and repeat gestures do not open inventory and runtime teardown retires shortcuts', () => {
  if (!runtime) {
    throw new Error('Missing runtime');
  }
  const field = document.createElement('input');
  document.body.append(field);
  field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
  document.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyV', repeat: true, bubbles: true })
  );
  expect(getOpenGameOverlay()).toBeNull();
  expect(views.at(-1)?.overlay).toBeNull();
  const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
  if (!ship) {
    throw new Error('Missing local ship');
  }
  ship.furnaceTransit = {
    sourceId: 'town-square',
    destinationId: 'street-1-0',
    startedAt: 0,
    durationMs: 1000,
  };
  runtime.commands.openInventory();
  expect(getOpenGameOverlay()).toBeNull();
  ship.furnaceTransit = null;
  runtime.commands.openInventory();
  expect(getOpenGameOverlay()).toBe('inventory');
  expect(views.at(-1)?.overlay).toBe('inventory');
  runtime.dispose();
  const key = new KeyboardEvent('keydown', {
    code: 'KeyV',
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  expect(getOpenGameOverlay()).toBeNull();
  expect(views.at(-1)?.overlay).toBeNull();
  field.remove();
});
