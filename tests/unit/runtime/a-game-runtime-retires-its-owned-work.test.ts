import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SNAPSHOT_VERSION, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { SatellitePickupData } from '../../../shared-types';
import { GameController } from '../../../src/core/gameController';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { keys } from '../../../src/input/keybindings';
import * as touchControls from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import {
  createGameRuntime,
  type GameRuntime,
  type GameRuntimeHosts,
} from '../../../src/runtime/gameRuntime';
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
  document.body.innerHTML =
    '<main id="gameWrapper"><div id="gameArea"><canvas id="gameCanvas"></canvas><div id="legacy-play"></div></div><canvas id="title-terrain"></canvas><div id="legacy-menu"></div><div id="legacy-overlay"></div><div id="collector"></div><div id="start-screen"></div></main>';
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
    collector: element('collector'),
    legacyMenu: element('legacy-menu'),
    legacyPlay: element('legacy-play'),
    legacyOverlay: element('legacy-overlay'),
    placeChrome: vi.fn(),
  };
  scope = new AbortController();
});

afterEach(() => {
  current?.dispose();
  current = undefined;
  scope.abort();
  document.body.classList.remove('in-play', 'touch-play', 'debug-on');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a failed canvas initialization unwinds its hosts and permits a fresh runtime', () => {
  const context = vi.spyOn(hosts.canvas, 'getContext').mockReturnValue(null);
  expect(() => createGameRuntime(hosts, scope.signal)).toThrow('rendering context');
  expect(hosts.legacyMenu.childNodes).toHaveLength(0);
  expect(hosts.legacyPlay.childNodes).toHaveLength(0);
  expect(hosts.legacyOverlay.childNodes).toHaveLength(0);
  expect(canvasManager.getCanvas()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  context.mockRestore();
  current = createGameRuntime(hosts, scope.signal);
  expect(canvasManager.getCanvas()).toBe(hosts.canvas);
});

test('one runtime lease owns pagehide and abort releases it without retaining the callback', () => {
  current = createGameRuntime(hosts, scope.signal);
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
  current = createGameRuntime(hosts, new AbortController().signal);
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
  const joinWorld = vi.spyOn(NetworkManager.getInstance(), 'joinAndWaitForWorld');
  current = createGameRuntime(hosts, scope.signal);
  current.commands.join('Waiting Pilot');
  current.commands.join('Duplicate Pilot');
  expect(connect).toHaveBeenCalledTimes(1);
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
    .spyOn(touchControls, 'initializeTouchControls')
    .mockImplementationOnce(() => {
      throw new Error('Touch host failed');
    });
  current = createGameRuntime(hosts, scope.signal);
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
  current = createGameRuntime(hosts, scope.signal);
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
  current = createGameRuntime(hosts, scope.signal);
  const first = await joinThroughTransport('First Pilot');
  current.dispose();
  expect(first.close).toHaveBeenCalledOnce();
  expect(first.onmessage).toBeNull();
  expect(first.onopen).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(frames.size).toBe(0);
  current = createGameRuntime(hosts, new AbortController().signal);
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
  current = createGameRuntime(hosts, scope.signal);
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
