/* @vitest-environment node */
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { ClientLogger } from '../../../server/services/ClientLogger';
import { logger } from '../../../setup/serverLogger';

let server: ReturnType<typeof createServerInstance> | undefined;
const sockets: WebSocket[] = [];

async function connect(path: string): Promise<WebSocket> {
  if (!server) {
    throw new Error('Test server is not running');
  }
  const socket = new WebSocket(`ws://127.0.0.1:${await server.listening}${path}`);
  socket.on('error', () => undefined);
  sockets.push(socket);
  await once(socket, 'open');
  return socket;
}

function sendOneChunk(socket: WebSocket, frames: readonly string[]): void {
  const transport = (socket as unknown as { _socket: { cork(): void; uncork(): void } })._socket;
  transport.cork();
  try {
    for (const frame of frames) {
      socket.send(frame);
    }
  } finally {
    transport.uncork();
  }
}

async function drainDeferredFrames(): Promise<void> {
  for (let step = 0; step < 16; step += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  }
  await server?.close();
  server = undefined;
});

test('public WebSockets reject inbound frames larger than 64 KiB', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const logs = await connect('/logs');
  const closed = once(logs, 'close');

  logs.send(
    JSON.stringify({
      type: 'clientLog',
      data: { level: 'ERROR', line: 'x'.repeat(70 * 1024) },
    })
  );

  const [code] = await closed;
  expect(code).toBe(1009);
});

test('the log route closes invalid schemas while preserving valid forwarding', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const valid = await connect('/logs');
  valid.send(
    JSON.stringify({
      type: 'clientLog',
      data: { level: 'INFO', message: 'bounded forwarding remains active' },
    })
  );
  const pong = once(valid, 'pong');
  valid.ping();
  await pong;
  expect(valid.readyState).toBe(WebSocket.OPEN);

  const invalid = await connect('/logs');
  const closed = once(invalid, 'close');
  invalid.send(
    JSON.stringify({ type: 'clientLog', data: { level: 'TRACE', message: 'not allowed' } })
  );
  const [code] = await closed;
  expect(code).toBe(1006);
});

test('a log socket past its message quota closes once', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const before = ClientLogger.getDiagnostics().rateLimited;
  const logs = await connect('/logs');
  const closed = once(logs, 'close');
  const filler = JSON.stringify({
    type: 'clientLog',
    data: { level: 'INFO', message: 'routine', sessionId: 'quota' },
  });
  const overQuota = JSON.stringify({
    type: 'clientLog',
    data: { level: 'WARN', message: 'over quota', sessionId: 'quota' },
  });
  sendOneChunk(logs, [
    ...Array.from({ length: 120 }, () => filler),
    overQuota,
    overQuota,
    overQuota,
    overQuota,
  ]);
  const [code] = await closed;
  await drainDeferredFrames();
  expect(code).toBe(1006);
  expect(logs.readyState).toBe(WebSocket.CLOSED);
  expect(ClientLogger.getDiagnostics().rateLimited).toBe(before + 1);
});

test('a bad log frame ends the socket so a following frame is not parsed', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const before = ClientLogger.getDiagnostics();
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    for (const frame of [
      '{broken',
      JSON.stringify({ type: 'unexpected', data: { message: 'discard this' } }),
    ]) {
      const socket = await connect('/logs');
      const closed = once(socket, 'close');
      sendOneChunk(socket, [frame, frame]);
      expect((await closed)[0]).toBe(1006);
      await drainDeferredFrames();
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }
    const after = ClientLogger.getDiagnostics();
    expect(after.invalid).toBe(before.invalid + 2);
    expect(after.accepted).toBe(before.accepted);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
