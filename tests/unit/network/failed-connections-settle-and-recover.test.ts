import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { CONNECTION_HANDSHAKE_TIMEOUT_MS } from '../../../src/network/services/connectionHealth';
import { logger } from '../../../src/utils/Logger';

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
  await vi.advanceTimersByTimeAsync(30_000);
  expect(Transport.created).toHaveLength(1);
});

test('five failed reconnect handshakes end in one permanent disconnect with no remaining retry', async () => {
  const socket = await open();
  const permanentlyDisconnected = vi.fn();
  window.addEventListener('networkPermanentlyDisconnected', permanentlyDisconnected);
  try {
    socket.close();
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
