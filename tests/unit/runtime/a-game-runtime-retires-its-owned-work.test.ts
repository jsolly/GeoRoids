import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SNAPSHOT_VERSION, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { SatellitePickupData } from '../../../shared-types';
import * as audioRuntime from '../../../src/audio/audioRuntime';
import { GameController } from '../../../src/core/gameController';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { controlSources } from '../../../src/input/controlSources';
import { keys } from '../../../src/input/keybindings';
import * as playfieldSelection from '../../../src/input/playfieldSelection';
import * as touchControls from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import {
  createGameRuntime,
  type GameRuntime,
  type GameRuntimeHosts,
} from '../../../src/runtime/gameRuntime';
import { getOpenGameOverlay } from '../../../src/runtime/overlayState';
import type { GamePresentation } from '../../../src/runtime/uiTypes';
import { logger } from '../../../src/utils/Logger';
import { snapshotFixture } from '../network/snapshotFixture';

// Logging transport is external to the gameplay runtime under test.
vi.mock('../../../src/utils/logForwarder', () => ({
  startClientLogForwarder: vi.fn(),
  stopClientLogForwarder: vi.fn(),
  forwardLogToServer: vi.fn(),
}));

let current: GameRuntime | undefined;
let scope: AbortController;
let hosts: GameRuntimeHosts;
let nextFrame: number;
const frames = new Map<number, FrameRequestCallback>();

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
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
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  document.body.innerHTML =
    '<main id="gameWrapper"><div id="gameArea"><canvas id="gameCanvas"></canvas><canvas id="spawn-fly-in"></canvas></div><canvas id="title-terrain"></canvas></main>';
  const element = <T extends HTMLElement>(id: string): T => {
    const node = document.querySelector<T>(`#${id}`);
    if (!node) {
      throw new Error(`Missing fixture ${id}`);
    }
    return node;
  };
  hosts = {
    canvas: element<HTMLCanvasElement>('gameCanvas'),
    titleCanvas: element<HTMLCanvasElement>('title-terrain'),
    spawnCanvas: element<HTMLCanvasElement>('spawn-fly-in'),
    placeChrome: vi.fn(),
  };
  scope = new AbortController();
});

/** A headless consumer performs the body-mode projection that GameShell owns. */
function mountRuntime(signal: AbortSignal): GameRuntime {
  const runtime = createGameRuntime(hosts, signal);
  runtime.subscribe((view) => document.body.classList.toggle('in-play', view.inPlay));
  return runtime;
}

function keyboard(code: string, target: EventTarget = document, repeat = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, repeat });
  target.dispatchEvent(event);
  return event;
}

async function joinWithAcceptedWorld(): Promise<void> {
  vi.spyOn(NetworkManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(NetworkManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
  current = mountRuntime(scope.signal);
  current.commands.join('Map Pilot');
  await settle();
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
}

afterEach(() => {
  current?.dispose();
  current = undefined;
  scope.abort();
  document.body.classList.remove('in-play', 'touch-play', 'debug-on');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a failed canvas initialization retires its work and permits a fresh runtime on the same supplied canvases', () => {
  const context = vi.spyOn(hosts.canvas, 'getContext').mockReturnValue(null);
  expect(() => createGameRuntime(hosts, scope.signal)).toThrow('rendering context');
  expect(document.querySelectorAll('canvas')).toHaveLength(3);
  expect(hosts.spawnCanvas.isConnected).toBe(true);
  expect(frames.size).toBe(0);
  expect(canvasManager.getCanvas()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  context.mockRestore();
  current = mountRuntime(scope.signal);
  expect(canvasManager.getCanvas()).toBe(hosts.canvas);
});

test('one runtime lease owns pagehide and abort releases it without retaining the callback', () => {
  current = mountRuntime(scope.signal);
  expect(() => createGameRuntime(hosts, new AbortController().signal)).toThrow('already mounted');
  const disconnect = vi.spyOn(ConnectionManager.getInstance(), 'disconnect');
  window.dispatchEvent(new Event('pagehide'));
  expect(disconnect).toHaveBeenCalledTimes(1);
  scope.abort();
  expect(disconnect).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('pagehide'));
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(window.gameController).toBeUndefined();
  current.dispose();
  expect(disconnect).toHaveBeenCalledTimes(2);
  current = mountRuntime(new AbortController().signal);
  window.dispatchEvent(new Event('pagehide'));
  expect(disconnect).toHaveBeenCalledTimes(3);
});

test('unmounting during a pending connection prevents a late join, input or animation loop', async () => {
  let accept: (() => void) | undefined;
  const connect = vi.spyOn(NetworkManager.getInstance(), 'connect').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      })
  );
  const activateAudio = vi.spyOn(audioRuntime, 'activateAudio');
  const joinWorld = vi.spyOn(NetworkManager.getInstance(), 'joinAndWaitForWorld');
  current = mountRuntime(scope.signal);
  current.commands.join('Waiting Pilot');
  current.commands.join('Duplicate Pilot');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(activateAudio).toHaveBeenCalledTimes(1);
  current.dispose();
  accept?.();
  await settle();
  expect(joinWorld).not.toHaveBeenCalled();
  expect(GameController.getInstance().getIsGameRunning()).toBe(false);
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(canvasManager.getCanvas()).toBeNull();
});

test('a failed child input initializer retires partial handlers before the pilot retries', async () => {
  vi.spyOn(NetworkManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(NetworkManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
  const initialize = vi
    .spyOn(playfieldSelection, 'initializePlayfieldSelection')
    .mockImplementationOnce(() => {
      throw new Error('Selection host failed');
    });
  current = mountRuntime(scope.signal);
  current.commands.join('Retry Pilot');
  await settle();
  expect(GameController.getInstance().getIsGameRunning()).toBe(false);
  const warning = vi.spyOn(logger, 'warn');
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  expect(warning).not.toHaveBeenCalled();
  expect(keys.Space).toBe(false);
  current.commands.join('Retry Pilot');
  await settle();
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  expect(GameController.getInstance().getCurrPlayer()?.ship.lasers).toHaveLength(1);
  current.dispose();
  warning.mockClear();
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  expect(warning).not.toHaveBeenCalled();
  expect(keys.Space).toBe(false);
});

class RecordingTransport {
  static OPEN = 1;
  static CONNECTING = 0;
  static created: RecordingTransport[] = [];
  readyState = RecordingTransport.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn<(text: string) => void>();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  constructor() {
    RecordingTransport.created.push(this);
  }
  receive(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, timestamp: 1 }) });
  }
}

async function joinThroughTransport(name: string): Promise<RecordingTransport> {
  current?.commands.join(name);
  const socket = RecordingTransport.created.at(-1);
  if (!socket) {
    throw new Error('Expected a socket owned by this runtime');
  }
  socket.readyState = RecordingTransport.OPEN;
  socket.onopen?.();
  await settle();
  expect(socket.send.mock.calls.map(([text]) => JSON.parse(text).type)).toContain('join');
  const id = ConnectionManager.getInstance().getClientId();
  socket.receive('joined', {
    id,
    name,
    position: { x: 500, y: 600 },
    color: '#fff',
    snapshotVersion: SNAPSHOT_VERSION,
    asteroidInteractions: 1,
    resumeToken: 'a'.repeat(64),
  });
  const state = snapshotFixture();
  const local = state.entities[0];
  if (!local) {
    throw new Error('Expected a local snapshot fixture');
  }
  local.id = id;
  local.name = name;
  local.position = { x: 500, y: 600 };
  socket.receive('snapshot', new SnapshotEncoder(state).encode(1));
  await settle();
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
  return socket;
}

test('disposing a connecting runtime retires its socket and ignores a late open', async () => {
  RecordingTransport.created = [];
  vi.stubGlobal('WebSocket', RecordingTransport);
  current = mountRuntime(scope.signal);
  current.commands.join('Waiting Transport Pilot');
  const socket = RecordingTransport.created[0];
  expect(socket).toBeDefined();
  const lateOpen = socket?.onopen;
  current.dispose();
  lateOpen?.();
  await settle();
  expect(socket?.close).toHaveBeenCalledOnce();
  expect(socket?.send).not.toHaveBeenCalled();
  expect(ConnectionManager.getInstance().getSocket()).toBeNull();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('a real transport join can retire and rejoin with one input and network owner', async () => {
  RecordingTransport.created = [];
  vi.stubGlobal('WebSocket', RecordingTransport);
  current = mountRuntime(scope.signal);
  const first = await joinThroughTransport('First Pilot');
  current.dispose();
  expect(first.close).toHaveBeenCalledOnce();
  expect(first.onmessage).toBeNull();
  expect(first.onopen).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(frames.size).toBe(0);
  current = mountRuntime(new AbortController().signal);
  const second = await joinThroughTransport('Second Pilot');
  expect(second).not.toBe(first);
  expect(RecordingTransport.created).toHaveLength(2);
  expect(frames.size).toBe(2);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  expect(GameController.getInstance().getCurrPlayer()?.ship.lasers).toHaveLength(1);
  // The accepted key skips the spawn fly-in; the single game loop remains.
  expect(frames.size).toBe(1);
  current.dispose();
  expect(keys.Space).toBe(false);
  const warning = vi.spyOn(logger, 'warn');
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  expect(keys.Space).toBe(false);
  expect(warning).not.toHaveBeenCalled();
  expect(second.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(RecordingTransport.created).toHaveLength(2);
  expect(frames.size).toBe(0);
});

test('foreign pickup churn does not flush sampled local inventory values between presentation ticks', async () => {
  vi.spyOn(NetworkManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(NetworkManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
  current = mountRuntime(scope.signal);
  current.commands.join('Inventory Pilot');
  await settle();
  const player = GameController.getInstance().getCurrPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  const manager = SatellitePickupManager.getInstance();
  manager.clear();
  player.silk = 10;
  current.commands.openInventory();
  const views: GamePresentation[] = [];
  const unsubscribe = current.subscribe((view) => views.push(view));
  const initialCount = views.length;
  expect(views.at(-1)?.inventory?.silk).toBe(10);
  player.silk = 11;
  const foreign: SatellitePickupData = {
    id: 'foreign-satellite',
    ownerId: 'another-pilot',
    name: 'Foreign satellite',
    typeId: 'landsat-7',
    assetKey: 'eo/landsat-7',
    position: { x: 100, y: 200 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    radius: 12,
    color: '#C4B5FD',
    state: 'stored' as const,
    health: 50,
    maxHealth: 50,
  };
  manager.syncFromServer([foreign]);
  manager.syncFromServer([{ ...foreign, state: 'orbiting' }]);
  manager.syncFromServer([]);
  expect(views).toHaveLength(initialCount);
  expect(views.at(-1)?.inventory?.silk).toBe(10);
  manager.syncFromServer([{ ...foreign, id: 'local-satellite', ownerId: player.id }]);
  expect(views).toHaveLength(initialCount + 1);
  expect(views.at(-1)?.inventory?.items[0]?.id).toBe('local-satellite');
  expect(views.at(-1)?.inventory?.silk).toBe(11);
  unsubscribe();
});

test('a failed touch mount removes its partial playfield listeners before a new runtime mounts', async () => {
  const original = touchControls.initializeTouchControls;
  const initialize = vi
    .spyOn(touchControls, 'initializeTouchControls')
    .mockImplementationOnce((host) => {
      original(host);
      throw new Error('Touch host failed');
    });
  expect(() => mountRuntime(scope.signal)).toThrow('Touch host failed');
  expect(canvasManager.getCanvas()).toBeNull();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await joinWithAcceptedWorld();
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(
    touchControls.readActionControls(GameController.getInstance().getCurrPlayer() ?? null).inPlay
  ).toBe(true);
  keyboard('Space');
  expect(GameController.getInstance().getCurrPlayer()?.ship.lasers).toHaveLength(1);
  current?.dispose();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('M opens the shared overlay once, releases held controls, ignores repeats and closes through the command port', async () => {
  await joinWithAcceptedWorld();
  if (!current) {
    throw new Error('Missing runtime');
  }
  const opened = vi.fn();
  const closed = vi.fn();
  window.addEventListener('gameMapOpen', opened, { signal: scope.signal });
  window.addEventListener('gameMapClose', closed, { signal: scope.signal });
  const views: GamePresentation[] = [];
  current.subscribe((view) => views.push(view));
  const player = GameController.getInstance().getCurrPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  keys.Space = true;
  keys.ArrowRight = true;
  controlSources.pointerHeading = 1;
  controlSources.touchFire = true;
  player.ship.canShoot = false;
  expect(keyboard('KeyM').defaultPrevented).toBe(true);
  expect(views.at(-1)?.overlay).toBe('universe-map');
  expect(opened).toHaveBeenCalledOnce();
  expect(keys.Space).toBe(false);
  expect(keys.ArrowRight).toBe(false);
  expect(controlSources.pointerHeading).toBeNull();
  expect(controlSources.touchFire).toBe(false);
  expect(player.ship.canShoot).toBe(true);
  expect(player.ship.movementLocked).toBe(true);
  expect(keyboard('KeyM', document, true).defaultPrevented).toBe(true);
  expect(views.at(-1)?.overlay).toBe('universe-map');
  expect(opened).toHaveBeenCalledOnce();
  keyboard('Space');
  expect(player.ship.lasers).toHaveLength(0);
  keyboard('KeyM');
  expect(views.at(-1)?.overlay).toBeNull();
  expect(player.ship.movementLocked).toBe(false);
  expect(closed).toHaveBeenCalledOnce();
  current.commands.openUniverseMap();
  expect(opened).toHaveBeenCalledTimes(2);
  current.commands.closeUniverseMap();
  expect(closed).toHaveBeenCalledTimes(2);
  current.commands.closeUniverseMap();
  expect(closed).toHaveBeenCalledTimes(2);
});

test('map shortcuts leave menu name entry and editable play controls alone and never open outside play', async () => {
  current = mountRuntime(scope.signal);
  const name = document.createElement('input');
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  document.body.append(name, editor);
  current.commands.openUniverseMap();
  expect(getOpenGameOverlay()).toBeNull();
  expect(keyboard('KeyM').defaultPrevented).toBe(false);
  expect(keyboard('KeyM', name).defaultPrevented).toBe(false);
  vi.spyOn(NetworkManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(NetworkManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
  current.commands.join('Typing Pilot');
  await settle();
  for (const target of [name, editor]) {
    expect(keyboard('KeyM', target).defaultPrevented).toBe(false);
    expect(getOpenGameOverlay()).toBeNull();
  }
  keyboard('KeyM');
  expect(getOpenGameOverlay()).toBe('universe-map');
  expect(keyboard('KeyM', name).defaultPrevented).toBe(false);
  expect(getOpenGameOverlay()).toBe('universe-map');
  window.dispatchEvent(new Event('playViewOff'));
  expect(getOpenGameOverlay()).toBeNull();
  expect(keyboard('KeyM').defaultPrevented).toBe(false);
  current.dispose();
  window.dispatchEvent(new Event('playViewOn'));
  expect(keyboard('KeyM').defaultPrevented).toBe(false);
  expect(getOpenGameOverlay()).toBeNull();
});

test('map-to-inventory handoff cancels captured canvas work immediately and runtime abort retires a reopened map', async () => {
  await joinWithAcceptedWorld();
  if (!current) {
    throw new Error('Missing runtime');
  }
  const mapCanvas = document.createElement('canvas');
  document.body.append(mapCanvas);
  const captured = new Set<number>();
  mapCanvas.setPointerCapture = (id) => {
    captured.add(id);
  };
  mapCanvas.hasPointerCapture = (id) => captured.has(id);
  const release = vi.fn((id: number) => {
    captured.delete(id);
  });
  mapCanvas.releasePointerCapture = release;
  const views: GamePresentation[] = [];
  current.subscribe((view) => views.push(view));
  current.commands.openUniverseMap();
  const baseline = frames.size;
  const chrome = vi.fn();
  const mounted = current.commands.mountUniverseMap(mapCanvas, chrome);
  expect(chrome).toHaveBeenCalledOnce();
  expect(frames.size).toBe(baseline + 1);
  for (const pointerId of [8, 9]) {
    const event = new Event('pointerdown', { cancelable: true });
    Object.assign(event, {
      pointerId,
      pointerType: 'touch',
      button: 0,
      clientX: pointerId * 20,
      clientY: 100,
    });
    mapCanvas.dispatchEvent(event);
  }
  expect([...captured]).toEqual([8, 9]);
  current.commands.openInventory();
  expect(views.at(-1)?.overlay).toBe('inventory');
  expect(release.mock.calls).toEqual([[8], [9]]);
  // Pointerdown skips the spawn animation independently of map disposal.
  expect(frames.size).toBe(1);
  current.commands.closeUniverseMap();
  expect(getOpenGameOverlay()).toBe('inventory');
  mounted.zoomBy(2);
  expect(frames.size).toBe(1);
  current.commands.openUniverseMap();
  current.commands.mountUniverseMap(mapCanvas, chrome);
  expect(frames.size).toBe(2);
  scope.abort();
  expect(views.at(-1)?.overlay).toBeNull();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(getOpenGameOverlay()).toBeNull();
  mounted.dispose();
  current.dispose();
});

test('Space activates interactive chrome without firing while canvas Space still fires once', async () => {
  await joinWithAcceptedWorld();
  const button = document.createElement('button');
  const link = document.createElement('a');
  link.href = '/wiki/';
  document.body.append(button, link);
  for (const target of [button, link]) {
    keyboard('Space', target);
    expect(GameController.getInstance().getCurrPlayer()?.ship.lasers).toHaveLength(0);
    expect(keys.Space).toBe(false);
  }
  keyboard('Space', hosts.canvas);
  expect(GameController.getInstance().getCurrPlayer()?.ship.lasers).toHaveLength(1);
});

test('a failed rendered frame closes an open map and publishes a restart notice without leaving a loop running', async () => {
  await joinWithAcceptedWorld();
  if (!current) {
    throw new Error('Missing runtime');
  }
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  keyboard('KeyM');
  const views: GamePresentation[] = [];
  current.subscribe((view) => views.push(view));
  vi.spyOn(GameController.getInstance(), 'renderGame').mockImplementationOnce(() => {
    throw new Error('Renderer failed');
  });
  const frame = [...frames.entries()].at(-1);
  if (!frame) {
    throw new Error('Missing game frame');
  }
  frames.delete(frame[0]);
  frame[1](performance.now() + 16);
  expect(GameController.getInstance().getIsGameRunning()).toBe(false);
  expect(views.at(-1)?.inPlay).toBe(false);
  expect(views.at(-1)?.overlay).toBeNull();
  expect(views.at(-1)?.failureNotice).toBe(
    'An unexpected error occurred. Enter the game again to restart.'
  );
  expect(frames.size).toBe(0);
  current.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
