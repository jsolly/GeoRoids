import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import {
  CONNECTION_HANDSHAKE_TIMEOUT_MS,
  JOIN_COMPLETION_TIMEOUT_MS,
} from '../../../src/network/services/connectionHealth';
import { logger } from '../../../src/utils/Logger';
import { snapshotFixture } from './snapshotFixture';

class Transport {
  static OPEN = 1;
  static CONNECTING = 0;
  static created: Transport[] = [];
  readyState = Transport.CONNECTING;
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
    Transport.created.push(this);
  }
  open(): void {
    this.readyState = Transport.OPEN;
    this.onopen?.();
  }
  receive(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, timestamp: 1 }) });
  }
}

let manager: ConnectionManager;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('WebSocket', Transport);
  manager = ConnectionManager.getInstance();
  manager.disconnect();
  Transport.created = [];
});
afterEach(() => {
  manager.disconnect();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function latest(): Transport {
  const socket = Transport.created.at(-1);
  if (!socket) {
    throw new Error('Expected a connection attempt');
  }
  return socket;
}
async function open(): Promise<Transport> {
  const connected = manager.connect();
  const socket = latest();
  socket.open();
  await connected;
  return socket;
}

test('an unanswered initial handshake times out and permits an explicit retry', async () => {
  const failure = expect(manager.connect()).rejects.toThrow('timed out');
  const abandoned = latest();
  await vi.advanceTimersByTimeAsync(CONNECTION_HANDSHAKE_TIMEOUT_MS);
  await failure;
  expect(manager.isConnected()).toBe(false);
  expect(manager.getSocket()).toBeNull();
  expect(abandoned.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await open();
  expect(manager.isConnected()).toBe(true);
});

test('closing before open rejects the handshake without waiting for its deadline', async () => {
  const failure = expect(manager.connect()).rejects.toThrow('closed before connecting');
  latest().close();
  await failure;
  expect(manager.getSocket()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await open();
  expect(manager.isConnected()).toBe(true);
});

test('leaving while connecting settles the promise and ignores a late open callback', async () => {
  const failure = expect(manager.connect()).rejects.toThrow('cancelled');
  const abandoned = latest();
  const lateOpen = abandoned.onopen;
  manager.disconnect();
  await failure;
  await open();
  const current = manager.getSocket();
  lateOpen?.();
  expect(manager.getSocket()).toBe(current);
  expect(Transport.created).toHaveLength(2);
});

test('a thrown gameplay send reports failure and reconnects without replaying the command', async () => {
  const socket = await open();
  const cause = new Error('transport write failed');
  socket.send.mockImplementation(() => {
    throw cause;
  });
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  expect(manager.sendMessage({ type: 'useAbility', data: { abilityId: 'harpoon' } })).toBe(false);
  expect(error).toHaveBeenCalledWith('NETWORK', 'Failed to send gameplay message', cause);
  expect(manager.getSocket()).toBeNull();
  expect(manager.isConnected()).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  const replacement = latest();
  expect(replacement).not.toBe(socket);
  replacement.open();
  await Promise.resolve();
  expect(manager.isConnected()).toBe(true);
  expect(replacement.send).not.toHaveBeenCalled();
});

test('a socket close failure still clears local state and never retries an intentional leave', async () => {
  const socket = await open();
  const cause = new Error('close failed');
  socket.close.mockImplementation(() => {
    throw cause;
  });
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  manager.disconnect();
  expect(manager.getSocket()).toBeNull();
  expect(manager.isConnected()).toBe(false);
  expect(socket.onopen).toBeNull();
  expect(socket.onclose).toBeNull();
  expect(error).toHaveBeenCalledWith('NETWORK', 'Failed to close retired WebSocket', cause);
  expect(logger.warn).not.toHaveBeenCalledWith('NETWORK', 'WebSocket connection closed');
  expect(logger.info).toHaveBeenCalledWith(
    'STATE',
    'transport_closed',
    expect.objectContaining({ userRequested: true, reason: 'requested' })
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(Transport.created).toHaveLength(1);
});

test('five failed reconnect handshakes end in one permanent disconnect with no remaining retry', async () => {
  const socket = await open();
  const permanentlyDisconnected = vi.fn();
  window.addEventListener('networkPermanentlyDisconnected', permanentlyDisconnected);
  try {
    socket.close();
    expect(logger.warn).toHaveBeenCalledWith('NETWORK', 'WebSocket connection closed');
    expect(logger.info).toHaveBeenCalledWith(
      'STATE',
      'transport_closed',
      expect.objectContaining({ userRequested: false, reason: 'unexpected' })
    );
    const delays = [500, 1000, 2000, 4000, 8000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(Transport.created).toHaveLength(index + 2);
      await vi.advanceTimersByTimeAsync(CONNECTION_HANDSHAKE_TIMEOUT_MS);
    }
    expect(permanentlyDisconnected).toHaveBeenCalledOnce();
    expect(manager.isConnected()).toBe(false);
    expect(manager.getSocket()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Transport.created).toHaveLength(6);
  } finally {
    window.removeEventListener('networkPermanentlyDisconnected', permanentlyDisconnected);
  }
});

test('join completion timeout restores the permanent-disconnect path and settles diagnostics', async () => {
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const socket = await open();
  const joinFailure = vi.spyOn(clientPerformance, 'joinFailed');
  const recoveryFailure = vi.spyOn(clientPerformance, 'recoveryFailed');
  const permanentDisconnect = vi.fn();
  window.addEventListener('networkPermanentlyDisconnected', permanentDisconnect);
  clientPerformance.serverReleaseId = 'stale-release';
  try {
    manager.initializeAsteroidSync();
    await vi.advanceTimersByTimeAsync(JOIN_COMPLETION_TIMEOUT_MS);

    expect(joinFailure).toHaveBeenCalledOnce();
    expect(recoveryFailure).toHaveBeenCalledOnce();
    expect(permanentDisconnect).toHaveBeenCalledOnce();
    expect(manager.isConnected()).toBe(false);
    expect(manager.getSocket()).toBeNull();
    expect(clientPerformance.serverReleaseId).toBeUndefined();
    expect(socket.close).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'NETWORK',
      'Failed to complete server join',
      expect.any(Error)
    );
    expect(logger.info).toHaveBeenCalledWith(
      'STATE',
      'transport_closed',
      expect.objectContaining({ userRequested: false, reason: 'join-failed' })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Transport.created).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    wallClock.mockRestore();
    window.removeEventListener('networkPermanentlyDisconnected', permanentDisconnect);
  }
});

test('intentional disconnect settles an open pending join before teardown', async () => {
  const socket = await open();
  const joinFailure = vi.spyOn(clientPerformance, 'joinFailed');
  manager.initializeAsteroidSync();

  manager.disconnect();
  await vi.advanceTimersByTimeAsync(JOIN_COMPLETION_TIMEOUT_MS);

  expect(joinFailure).toHaveBeenCalledOnce();
  expect(manager.isConnected()).toBe(false);
  expect(manager.getSocket()).toBeNull();
  expect(socket.close).toHaveBeenCalled();
});

test('a pre-join server error fails the attempt while a post-join error leaves the socket alive', async () => {
  const preJoin = await open();
  const permanentDisconnect = vi.fn();
  window.addEventListener('networkPermanentlyDisconnected', permanentDisconnect);
  try {
    manager.initializeAsteroidSync();
    preJoin.receive('error', 'The game server is full');
    expect(permanentDisconnect).toHaveBeenCalledOnce();
    expect(manager.isConnected()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      'STATE',
      'transport_closed',
      expect.objectContaining({ userRequested: false, reason: 'join-failed' })
    );
  } finally {
    window.removeEventListener('networkPermanentlyDisconnected', permanentDisconnect);
  }

  const postJoin = await open();
  const postJoinPermanentDisconnect = vi.fn();
  window.addEventListener('networkPermanentlyDisconnected', postJoinPermanentDisconnect);
  try {
    manager.initializeAsteroidSync();
    postJoin.receive('joined', {
      id: manager.getClientId(),
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      color: '#fff',
    });
    postJoin.receive('error', 'Ability unavailable');
    expect(postJoinPermanentDisconnect).not.toHaveBeenCalled();
    expect(manager.isConnected()).toBe(true);
  } finally {
    window.removeEventListener('networkPermanentlyDisconnected', postJoinPermanentDisconnect);
  }
});

test('the first local authoritative state clears the join completion deadline', async () => {
  const player = entityFactory.createLocalPlayer('Runtime pilot', { x: 0, y: 0 });
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(player);
  manager.setLocalPlayerName('Runtime pilot');
  const socket = await open();
  const permanentDisconnect = vi.fn();
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  window.addEventListener('networkPermanentlyDisconnected', permanentDisconnect);
  try {
    manager.initializeAsteroidSync();
    socket.receive('joined', {
      id: manager.getClientId(),
      name: 'Runtime pilot',
      position: { x: 0, y: 0 },
      color: '#fff',
    });
    const state = snapshotFixture();
    const local = state.entities[0];
    if (!local) {
      throw new Error('Expected a local snapshot fixture entity');
    }
    local.id = manager.getClientId();
    local.name = 'Runtime pilot';
    socket.receive('gameState', state);

    await vi.advanceTimersByTimeAsync(JOIN_COMPLETION_TIMEOUT_MS);
    expect(permanentDisconnect).not.toHaveBeenCalled();
    expect(manager.isConnected()).toBe(true);
  } finally {
    wallClock.mockRestore();
    window.removeEventListener('networkPermanentlyDisconnected', permanentDisconnect);
  }
});

test('resync diagnostics count successful sends only', async () => {
  const first = await open();
  const count = vi.spyOn(clientPerformance, 'count');
  const acknowledgeJoin = (socket: Transport) => {
    manager.initializeAsteroidSync();
    socket.receive('joined', {
      id: manager.getClientId(),
      name: 'Resync pilot',
      position: { x: 0, y: 0 },
      color: '#fff',
      snapshotVersion: 1,
    });
  };

  acknowledgeJoin(first);
  count.mockClear();
  first.send.mockClear();
  first.receive('snapshot', { kind: 'delta', sequence: 2, baseline: 1 });
  expect(first.send).toHaveBeenCalledOnce();
  expect(JSON.parse(first.send.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
    type: 'snapshotResync',
  });
  expect(count).toHaveBeenCalledWith('resyncs');

  manager.disconnect();
  const second = await open();
  acknowledgeJoin(second);
  count.mockClear();
  second.send.mockImplementation(() => {
    throw new Error('resync send failed');
  });
  second.receive('snapshot', { kind: 'delta', sequence: 2, baseline: 1 });
  expect(count).not.toHaveBeenCalledWith('resyncs');
  expect(manager.isConnected()).toBe(false);
  expect(first.close).toHaveBeenCalled();
});
