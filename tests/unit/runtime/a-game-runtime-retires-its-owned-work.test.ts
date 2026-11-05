import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SNAPSHOT_VERSION, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { SatellitePickupData } from '../../../shared-types';
import * as audioRuntime from '../../../src/audio/audioRuntime';
import * as feedbackSounds from '../../../src/audio/feedbackSounds';
import { GameController } from '../../../src/core/gameController';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { controlSources } from '../../../src/input/controlSources';
import { getPressedKeysForPlayer } from '../../../src/input/keybindings';
import * as playfieldSelection from '../../../src/input/playfieldSelection';
import * as touchControls from '../../../src/input/touchControls';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import {
  createGameRuntime,
  type GameRuntime,
  type GameRuntimeHosts,
} from '../../../src/runtime/gameRuntime';
import { getOpenGameOverlay } from '../../../src/runtime/overlayState';
import type { GamePresentation } from '../../../src/runtime/uiTypes';
import { setPlayView } from '../../../src/ui/uiUtils';
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

function canvasContextMenuIsPrevented(): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  hosts.canvas.dispatchEvent(event);
  return event.defaultPrevented;
}

async function joinWithAcceptedWorld(): Promise<void> {
  vi.spyOn(ConnectionManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(ConnectionManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
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
  const connect = vi.spyOn(ConnectionManager.getInstance(), 'connect').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      })
  );
  const activateAudio = vi.spyOn(audioRuntime, 'activateAudio');
  const joinWorld = vi.spyOn(ConnectionManager.getInstance(), 'joinAndWaitForWorld');
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
  vi.spyOn(ConnectionManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(ConnectionManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
  const initialize = vi
    .spyOn(playfieldSelection, 'initializePlayfieldSelection')
    .mockImplementationOnce(() => {
      throw new Error('Selection host failed');
    });
  current = mountRuntime(scope.signal);
  current.commands.join('Retry Pilot');
  await settle();
  expect(GameController.getInstance().getIsGameRunning()).toBe(false);
  expect(canvasContextMenuIsPrevented()).toBe(false);
  current.commands.join('Retry Pilot');
  await settle();
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
  expect(canvasContextMenuIsPrevented()).toBe(true);
  const pilot = GameController.getInstance().getCurrPlayer();
  if (!pilot) {
    throw new Error('Missing retry pilot');
  }
  const shoot = vi.spyOn(pilot.ship, 'shoot');
  keyboard('Space');
  expect(shoot).toHaveBeenCalledOnce();
  expect(pilot.ship.lasers).toHaveLength(1);
  current.dispose();
  expect(canvasContextMenuIsPrevented()).toBe(false);
  keyboard('Space');
  expect(shoot).toHaveBeenCalledOnce();
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
  await acceptTransportJoin(socket, name);
  return socket;
}

async function acceptTransportJoin(socket: RecordingTransport, name: string): Promise<void> {
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
    terrainSeed: 7,
    serverReleaseId: '7'.repeat(40),
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
  local.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
  socket.receive('snapshot', new SnapshotEncoder(state).encode(1));
  expect(clientPerformance.read().serverReleaseId).toBe('7'.repeat(40));
  await settle();
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
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

test('retired crew commands cannot reach the replacement runtime', async () => {
  await joinWithAcceptedWorld();
  const retired = current;
  const retiredShip = GameController.getInstance().getCurrPlayer()?.ship;
  if (!retired || !retiredShip) {
    throw new Error('Missing first runtime pilot');
  }
  retired.dispose();
  await joinWithAcceptedWorld();
  const runtime = current;
  const pilot = GameController.getInstance().getCurrPlayer();
  if (!runtime || !pilot) {
    throw new Error('Missing replacement runtime pilot');
  }
  const ship = pilot.ship;
  expect(ship).not.toBe(retiredShip);
  const send = vi.spyOn(ConnectionManager.getInstance(), 'sendMessage').mockReturnValue(true);
  const position = { ...ship.position };
  runtime.commands.crewAction({ kind: 'revive', targetId: 'current-friend' });
  expect(ship.rescue?.targetId).toBe('current-friend');
  runtime.commands.crewAction({ kind: 'release' });
  expect(ship.rescue).toBeNull();
  runtime.commands.signalHere('help');
  runtime.commands.signalHere('nest');
  expect(send.mock.calls.map(([message]) => message)).toEqual([
    { type: 'crewAction', id: pilot.id, data: { kind: 'revive', targetId: 'current-friend' } },
    { type: 'crewAction', id: pilot.id, data: { kind: 'release' } },
    { type: 'crewAction', id: pilot.id, data: { kind: 'signal', signal: 'help', position } },
    { type: 'crewAction', id: pilot.id, data: { kind: 'signal', signal: 'nest', position } },
  ]);

  runtime.commands.crewAction({ kind: 'revive', targetId: 'current-friend' });
  const rescue = ship.rescue;
  expect(rescue?.targetId).toBe('current-friend');
  ship.velocity = { x: 4, y: -2 };
  ship.thrusting = true;
  ship.contourLock = { height: 0.1, direction: 1 };
  const before = structuredClone({
    rescue,
    position: ship.position,
    velocity: ship.velocity,
    thrusting: ship.thrusting,
    contourLock: ship.contourLock,
  });
  send.mockClear();
  retired.commands.crewAction({ kind: 'release' });
  expect(ship.rescue).toBe(rescue);
  retired.commands.crewAction({ kind: 'revive', targetId: 'retired-friend' });
  retired.commands.signalHere('help');
  retired.commands.signalHere('nest');
  expect({
    rescue: ship.rescue,
    position: ship.position,
    velocity: ship.velocity,
    thrusting: ship.thrusting,
    contourLock: ship.contourLock,
  }).toEqual(before);
  expect(send).not.toHaveBeenCalled();
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
  expect(canvasContextMenuIsPrevented()).toBe(false);
  current = mountRuntime(new AbortController().signal);
  const second = await joinThroughTransport('Second Pilot');
  expect(second).not.toBe(first);
  expect(RecordingTransport.created).toHaveLength(2);
  expect(frames.size).toBe(2);
  expect(canvasContextMenuIsPrevented()).toBe(true);
  const pilot = GameController.getInstance().getCurrPlayer();
  if (!pilot) {
    throw new Error('Missing rejoined pilot');
  }
  const shoot = vi.spyOn(pilot.ship, 'shoot');
  keyboard('Space');
  expect(shoot).toHaveBeenCalledOnce();
  expect(pilot.ship.lasers).toHaveLength(1);
  // The accepted key skips the spawn fly-in; the single game loop remains.
  expect(frames.size).toBe(1);
  current.dispose();
  expect(canvasContextMenuIsPrevented()).toBe(false);
  keyboard('Space');
  expect(shoot).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(RecordingTransport.created).toHaveLength(2);
  expect(frames.size).toBe(0);
});

test('a mounted runtime clears an accepted server release when its transport closes', async () => {
  RecordingTransport.created = [];
  vi.stubGlobal('WebSocket', RecordingTransport);
  current = mountRuntime(scope.signal);
  const socket = await joinThroughTransport('Release Pilot');

  socket.close();
  expect(clientPerformance.read().serverReleaseId).toBe('unknown');
  expect(ConnectionManager.getInstance().getSocket()).toBeNull();

  current.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(frames.size).toBe(0);
});

test('changing the title ship plays one interface cue and repeating the same selection stays silent', () => {
  current = mountRuntime(scope.signal);
  const views: GamePresentation[] = [];
  const unsubscribe = current.subscribe((view) => views.push(view));
  const initial = views.at(-1)?.menu.selectedKit;
  if (!initial) {
    throw new Error('Expected a title ship selection');
  }
  const next = initial === 'scout' ? 'hauler' : 'scout';
  const feedback = vi.spyOn(feedbackSounds, 'playFeedback');

  current.commands.selectShip(next);
  expect(views.at(-1)?.menu.selectedKit).toBe(next);
  expect(feedback).toHaveBeenCalledExactlyOnceWith('interface');

  current.commands.selectShip(next);
  expect(feedback).toHaveBeenCalledTimes(1);

  current.commands.selectShip(initial);
  expect(views.at(-1)?.menu.selectedKit).toBe(initial);
  expect(feedback.mock.calls).toEqual([['interface'], ['interface']]);
  unsubscribe();
});

test('the travel presentation follows living crew snapshots without changing earlier views', async () => {
  RecordingTransport.created = [];
  vi.stubGlobal('WebSocket', RecordingTransport);
  const runtime = mountRuntime(scope.signal);
  current = runtime;
  const socket = await joinThroughTransport('Travel Pilot');
  // This scenario exercises snapshot delivery and DOM presentation, outside canvas painting.
  vi.spyOn(GameController.getInstance(), 'renderGame').mockImplementation(() => {});
  const local = GameController.getInstance().getCurrPlayer();
  const state = snapshotFixture();
  const template = state.entities[0];
  if (!local || !template) {
    throw new Error('Missing travel pilot fixture');
  }
  template.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
  template.velocity = { x: 0, y: 0 };
  template.thrusting = false;
  local.ship.position = { x: 40, y: 0 };
  state.entities = [
    { ...template, id: local.id, name: 'Travel Pilot', position: { x: 40, y: 0 } },
    { ...template, id: 'crew', name: 'Ada', position: { x: 900, y: 300 } },
    { ...template, id: 'dead', name: 'Dead pilot', health: 0 },
    { ...template, id: 'exploding', name: 'Exploding pilot', health: 0, exploding: true },
  ];
  socket.receive('snapshot', new SnapshotEncoder(state).encode(2));
  await settle();
  const views: GamePresentation[] = [];
  runtime.subscribe((view) => views.push(view));
  keyboard('KeyB');
  runtime.commands.selectTownView('travel');
  const first = views.at(-1)?.townTravel;
  if (!first) {
    throw new Error('Expected the runtime to publish furnace travel');
  }
  expect(first.pilots).toEqual([
    { id: local.id, name: 'Travel Pilot', position: { x: 40, y: 0 }, local: true },
    { id: 'crew', name: 'Ada', position: { x: 900, y: 300 }, local: false },
  ]);

  const updated = structuredClone(state);
  const crew = updated.entities[1];
  if (!crew) {
    throw new Error('Missing crew snapshot');
  }
  crew.name = 'Ada North';
  crew.position = { x: 1200, y: 450 };
  socket.receive('snapshot', new SnapshotEncoder(updated).encode(3));
  await settle();
  const frame = [...frames.entries()].at(-1);
  if (!frame) {
    throw new Error('Missing runtime presentation frame');
  }
  frames.delete(frame[0]);
  frame[1](performance.now() + 200);
  expect(views.at(-1)?.townTravel?.pilots).toContainEqual({
    id: 'crew',
    name: 'Ada North',
    position: { x: 1200, y: 450 },
    local: false,
  });
  expect(first.pilots).toEqual([
    { id: local.id, name: 'Travel Pilot', position: { x: 40, y: 0 }, local: true },
    { id: 'crew', name: 'Ada', position: { x: 900, y: 300 }, local: false },
  ]);
});

test('foreign pickup churn does not flush sampled local inventory values between presentation ticks', async () => {
  vi.spyOn(ConnectionManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(ConnectionManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
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

test.each(['alive', 'dead', 'exploding'])(
  'document left release rearms the %s pilot and cancels charge while right release preserves held actions',
  async (state) => {
    await joinWithAcceptedWorld();
    const player = GameController.getInstance().getCurrPlayer();
    if (!player) {
      throw new Error('Missing mouse pilot');
    }
    const ship = player.ship;
    const shoot = vi.spyOn(ship, 'shoot');
    const toggle = vi.spyOn(ship, 'toggleContourLock');
    const sendCharge = vi
      .spyOn(ConnectionManager.getInstance().combatNetwork, 'sendCharge')
      .mockReturnValue(true);
    hosts.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(shoot).toHaveBeenCalledOnce();
    expect(ship.lasers).toHaveLength(1);
    expect(ship.canShoot).toBe(false);
    expect(ship.thrusting).toBe(false);

    ship.beginWeaponCharge();
    const startedAt = ship.weaponChargeStartedAt;
    expect(startedAt).not.toBeNull();
    ship.weaponChargeFrames = 20;
    const contourLock = { height: 0.1, direction: 1 } satisfies NonNullable<
      typeof ship.contourLock
    >;
    ship.contourLock = contourLock;
    document.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
    expect(toggle).not.toHaveBeenCalled();
    expect(ship.contourLock).toBe(contourLock);
    expect(shoot).toHaveBeenCalledOnce();
    expect(ship.lasers).toHaveLength(1);
    expect(ship.thrusting).toBe(false);
    expect(ship.canShoot).toBe(false);
    expect(ship.weaponChargeStartedAt).toBe(startedAt);
    expect(ship.weaponChargeFrames).toBe(20);
    expect(sendCharge.mock.calls).toEqual([['start']]);

    if (state === 'dead') {
      ship.health = 0;
    }
    if (state === 'exploding') {
      ship.exploding = true;
    }
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    expect(ship.canShoot).toBe(true);
    expect(ship.weaponChargeStartedAt).toBeNull();
    expect(ship.weaponChargeFrames).toBe(0);
    expect(sendCharge.mock.calls).toEqual([['start'], ['cancel']]);
    expect(shoot).toHaveBeenCalledOnce();
    expect(ship.lasers).toHaveLength(1);
    if (state === 'alive') {
      expect(ship.thrusting).toBe(false);
      hosts.canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      expect(shoot).toHaveBeenCalledTimes(2);
      expect(ship.lasers).toHaveLength(2);
    }
  }
);

test('M opens the shared overlay once, releases held controls, ignores repeats and closes through the command port', async () => {
  await joinWithAcceptedWorld();
  if (!current) {
    throw new Error('Missing runtime');
  }
  const cue = vi.spyOn(feedbackSounds, 'playFeedback');
  const views: GamePresentation[] = [];
  current.subscribe((view) => views.push(view));
  const player = GameController.getInstance().getCurrPlayer();
  if (!player) {
    throw new Error('Missing local pilot');
  }
  getPressedKeysForPlayer(player).add('Space');
  getPressedKeysForPlayer(player).add('ArrowRight');
  controlSources.pointerHeading = 1;
  controlSources.touchFire = true;
  player.ship.canShoot = false;
  expect(keyboard('KeyM').defaultPrevented).toBe(true);
  expect(views.at(-1)?.overlay).toBe('universe-map');
  expect(cue).toHaveBeenCalledExactlyOnceWith('interface');
  expect(getPressedKeysForPlayer(player).size).toBe(0);
  expect(controlSources.pointerHeading).toBeNull();
  expect(controlSources.touchFire).toBe(false);
  expect(player.ship.canShoot).toBe(true);
  expect(player.ship.movementLocked).toBe(true);
  expect(keyboard('KeyM', document, true).defaultPrevented).toBe(true);
  expect(views.at(-1)?.overlay).toBe('universe-map');
  expect(cue).toHaveBeenCalledExactlyOnceWith('interface');
  keyboard('Space');
  expect(player.ship.lasers).toHaveLength(0);
  keyboard('KeyM');
  expect(views.at(-1)?.overlay).toBeNull();
  expect(player.ship.movementLocked).toBe(false);
  expect(cue).toHaveBeenCalledTimes(2);
  current.commands.openUniverseMap();
  expect(cue).toHaveBeenCalledTimes(3);
  current.commands.closeUniverseMap();
  expect(cue).toHaveBeenCalledTimes(4);
  expect(views.at(-1)?.overlay).toBeNull();
  current.commands.closeUniverseMap();
  expect(cue).toHaveBeenCalledTimes(4);
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
  vi.spyOn(ConnectionManager.getInstance(), 'connect').mockResolvedValue();
  vi.spyOn(ConnectionManager.getInstance(), 'joinAndWaitForWorld').mockResolvedValue(true);
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
  setPlayView(false);
  expect(getOpenGameOverlay()).toBeNull();
  expect(keyboard('KeyM').defaultPrevented).toBe(false);
  current.dispose();
  setPlayView(true);
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

test('wall-clock poses survive recovery and stop when play ends', async () => {
  RecordingTransport.created = [];
  vi.stubGlobal('WebSocket', RecordingTransport);
  current = mountRuntime(scope.signal);
  const views: GamePresentation[] = [];
  current.subscribe((view) => views.push(view));
  const socket = await joinThroughTransport('Pose Pilot');
  const player = GameController.getInstance().getCurrPlayer();
  if (!player || !current) {
    throw new Error('Missing runtime pilot');
  }
  const acceptedId = ConnectionManager.getInstance().getLocalPlayerId();
  expect(player.id).toBe(acceptedId);
  const pose = { position: { x: 120, y: -45 }, velocity: { x: 2, y: -3 }, angle: 0.75 };
  Object.assign(player.ship, pose);
  socket.send.mockClear();
  const updates = (transport: RecordingTransport) =>
    transport.send.mock.calls
      .map(([text]) => JSON.parse(text))
      .filter((message) => message.type === 'update');
  await vi.advanceTimersByTimeAsync(50);
  expect(updates(socket)).toEqual(
    Array.from({ length: 3 }, () =>
      expect.objectContaining({
        type: 'update',
        data: expect.objectContaining({ id: acceptedId, ...pose }),
      })
    )
  );

  const state = vi.spyOn(player, 'getStateForNetwork');
  socket.close();
  expect(GameController.getInstance().getIsGameRunning()).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(state).toHaveBeenCalled();
  expect(RecordingTransport.created).toHaveLength(2);
  const recovered = RecordingTransport.created.at(-1);
  if (!recovered || recovered === socket) {
    throw new Error('Expected a distinct reconnect transport');
  }
  await acceptTransportJoin(recovered, 'Pose Pilot');
  recovered.send.mockClear();
  await vi.advanceTimersByTimeAsync(50);
  expect(updates(recovered)).toHaveLength(3);

  recovered.receive('joined', {
    id: acceptedId,
    name: 'Pose Pilot',
    position: { x: 500, y: 600 },
    color: '#fff',
    snapshotVersion: SNAPSHOT_VERSION - 1,
    asteroidInteractions: 1,
    terrainSeed: 7,
    serverReleaseId: '7'.repeat(40),
    resumeToken: 'a'.repeat(64),
  });
  expect(recovered.close).toHaveBeenCalledOnce();
  expect(ConnectionManager.getInstance().getSocket()).toBeNull();
  expect(GameController.getInstance().getIsGameRunning()).toBe(false);
  expect(views.at(-1)?.inPlay).toBe(false);
  state.mockClear();
  await vi.advanceTimersByTimeAsync(100);
  expect(state).not.toHaveBeenCalled();
  expect(updates(recovered)).toHaveLength(3);

  const retry = await joinThroughTransport('Pose Pilot');
  const retryPlayer = GameController.getInstance().getCurrPlayer();
  if (!retryPlayer) {
    throw new Error('Missing retry pilot');
  }
  expect(retryPlayer).not.toBe(player);
  const retryState = vi.spyOn(retryPlayer, 'getStateForNetwork');
  retry.send.mockClear();
  await vi.advanceTimersByTimeAsync(50);
  expect(updates(retry)).toHaveLength(3);
  GameController.getInstance().stopAfterFrameFailure();
  retryState.mockClear();
  await vi.advanceTimersByTimeAsync(100);
  expect(retryState).not.toHaveBeenCalled();
  expect(updates(retry)).toHaveLength(3);
  current.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(retryState).not.toHaveBeenCalled();
  expect(updates(retry)).toHaveLength(3);
});
