/* @vitest-environment node */
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { ClientLogger } from '../../../server/services/ClientLogger';
import { logger } from '../../../setup/serverLogger';
import { createLogRecord, stringifyLogRecord } from '../../../shared/logRecords';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

let server: ReturnType<typeof createServerInstance> | undefined;
const clients = new Map<WebSocket, WireClient>();
const negativeSockets = new Set<WebSocket>();

async function connect(path: string): Promise<WebSocket> {
  if (!server) {
    throw new Error('Test server is not running');
  }
  const url = new URL(`ws://127.0.0.1:${await server.listening}${path}`);
  if (url.pathname === '/ws') {
    url.searchParams.set('snapshotVersion', String(SNAPSHOT_VERSION));
    url.searchParams.set('asteroidInteractions', '1');
    url.searchParams.set('explorationVersion', '1');
  }
  const socket = new WebSocket(url);
  const client = new WireClient(socket);
  clients.set(socket, client);
  await client.open();
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

afterEach(async () => {
  try {
    await closePlayerMotionScenario({
      clients: [...clients].map(([socket, client]) => ({
        async close() {
          await client.close();
          if (!negativeSockets.has(socket)) {
            client.assertHealthy();
          }
        },
      })),
      server,
    });
  } finally {
    clients.clear();
    negativeSockets.clear();
    server = undefined;
  }
});

test('public WebSockets reject inbound frames larger than 64 KiB', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const logs = await connect('/logs');
  negativeSockets.add(logs);
  const closed = once(logs, 'close', { signal: AbortSignal.timeout(2000) });

  logs.send(
    JSON.stringify({
      type: 'clientLog',
      data: { level: 'error', line: 'x'.repeat(70 * 1024) },
    })
  );

  const [code] = await closed;
  expect(code).toBe(1009);
});

function structuredLogFrame(): string {
  return JSON.stringify({
    type: 'clientLog',
    data: {
      level: 'info',
      sessionId: 'wire-session',
      line: stringifyLogRecord(
        createLogRecord({
          timestamp: new Date().toISOString(),
          source: 'client',
          level: 'info',
          releaseId: 'test',
          message: 'bounded forwarding remains active',
        })
      ),
    },
  });
}

test('/logs accepts structured records through the real ingress', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const before = ClientLogger.getDiagnostics();
  const valid = await connect('/logs');
  valid.send(structuredLogFrame());
  const pong = once(valid, 'pong', { signal: AbortSignal.timeout(2000) });
  valid.ping();
  await pong;
  expect(valid.readyState).toBe(WebSocket.OPEN);
  expect(ClientLogger.getDiagnostics().accepted).toBe(before.accepted + 1);
  expect(await ClientLogger.flushPending()).toBe(true);
});

test('the gameplay socket rejects log telemetry because /logs is the only log ingress', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const before = ClientLogger.getDiagnostics();
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const gameplay = await connect('/ws');
    const received: unknown[] = [];
    gameplay.on('message', (raw) => received.push(JSON.parse(String(raw))));
    gameplay.send(structuredLogFrame());
    // The server handles the text frame before answering the following ping.
    const pong = once(gameplay, 'pong', { signal: AbortSignal.timeout(2000) });
    gameplay.ping();
    await pong;
    expect(received).toContainEqual(
      expect.objectContaining({ type: 'error', data: 'Unknown message type: clientLog' })
    );
    expect(gameplay.readyState).toBe(WebSocket.OPEN);
    expect(ClientLogger.getDiagnostics().accepted).toBe(before.accepted);
  } finally {
    warn.mockRestore();
  }
});

test('the log route closes retired plaintext and invalid record schemas', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  for (const data of [
    { level: 'info', message: 'retired plaintext' },
    { level: 'info', line: '{broken', sessionId: 'wire-session' },
    { level: 'TRACE', line: 'not allowed', sessionId: 'wire-session' },
  ]) {
    const invalid = await connect('/logs');
    negativeSockets.add(invalid);
    const closed = once(invalid, 'close', { signal: AbortSignal.timeout(2000) });
    invalid.send(JSON.stringify({ type: 'clientLog', data }));
    const [code] = await closed;
    expect(code).toBe(1006);
  }
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
      const connected = once(server.wss, 'connection', { signal: AbortSignal.timeout(2000) });
      const [socket, [peer]] = await Promise.all([connect('/logs'), connected]);
      negativeSockets.add(socket);
      if (!(peer instanceof WebSocket)) {
        throw new Error('Missing owned log peer');
      }
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
      // Server close follows receiver completion, including buffered messages.
      const peerClosed = once(peer, 'close', { signal: AbortSignal.timeout(2000) });
      sendOneChunk(socket, [frame, frame]);
      const [clientClose] = await Promise.all([closed, peerClosed]);
      expect(clientClose[0]).toBe(1006);
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
