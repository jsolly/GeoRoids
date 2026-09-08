/* @vitest-environment node */
import { once } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import * as serverLogging from '../../../setup/serverLogger';

const servers: ReturnType<typeof createServerInstance>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  vi.restoreAllMocks();
});

async function start(nodeEnv = 'test') {
  const server = createServerInstance({ port: 0, nodeEnv });
  servers.push(server);
  const port = await server.listening;
  return { server, origin: `http://127.0.0.1:${port}`, socketUrl: `ws://127.0.0.1:${port}/ws` };
}

test.each([
  true,
  false,
])('the diagnostic route reflects the completed file write (%s)', async (written) => {
  vi.spyOn(serverLogging, 'writeServerDiagnostic').mockResolvedValue(written);
  const { origin } = await start();
  const response = await fetch(`${origin}/test-server-log`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(written ? 200 : 503);
  expect(await response.json()).toMatchObject({ status: written ? 'success' : 'error' });
});

test('repeated shutdown requests close live gameplay sockets and stop the game once', async () => {
  const { server, socketUrl } = await start();
  const socket = new WebSocket(socketUrl);
  sockets.push(socket);
  await once(socket, 'open');
  const stopped = vi.spyOn(server.gameEngine, 'stopGameLoop');
  const closed = once(socket, 'close');
  const shutdown = server.close();
  expect(server.close()).toBe(shutdown);
  await shutdown;
  const [code] = await closed;
  expect(code).toBe(1001);
  expect(stopped).toHaveBeenCalledOnce();
  expect(server.httpServer.listening).toBe(false);
  expect(server.wss.clients.size).toBe(0);
});

test('production exposes health while rejecting diagnostic log writes', async () => {
  const write = vi.spyOn(serverLogging, 'writeServerDiagnostic').mockResolvedValue(true);
  const { origin } = await start('production');
  const diagnostic = await fetch(`${origin}/test-server-log`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  expect(diagnostic.status).toBe(404);
  expect(write).not.toHaveBeenCalled();
  const status = await fetch(`${origin}/status`, {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(3000),
  });
  expect(await status.text()).not.toContain('id="serverLogBtn"');
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'healthy' });
});

test('a network peer cannot trigger development log writes by claiming a forwarded loopback address', async () => {
  const write = vi.spyOn(serverLogging, 'writeServerDiagnostic').mockResolvedValue(true);
  const { server } = await start('development');
  const peer = new Socket();
  Object.defineProperty(peer, 'remoteAddress', { value: '192.0.2.10' });
  const request = new IncomingMessage(peer);
  request.method = 'POST';
  request.url = '/test-server-log';
  request.headers['x-forwarded-for'] = '127.0.0.1';
  const response = new ServerResponse(request);
  try {
    server.httpServer.emit('request', request, response);
    expect(response.statusCode).toBe(404);
    expect(response.writableEnded).toBe(true);
    expect(write).not.toHaveBeenCalled();
  } finally {
    peer.destroy();
  }
});

test('status reports the actual connected log clients and bounded writer counters', async () => {
  const { origin } = await start();
  const logSocket = new WebSocket(`${origin.replace('http:', 'ws:')}/logs`);
  sockets.push(logSocket);
  await once(logSocket, 'open');
  const status = await fetch(`${origin}/status`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(3000),
  });
  const body = await status.json();
  expect(body).toMatchObject({
    connections: { activeLogClients: 1 },
    logging: {
      activeLogClients: 1,
      clientIngress: {
        accepted: expect.any(Number),
        droppedRecords: expect.any(Number),
        clientReportedDroppedRecords: expect.any(Number),
        writeErrors: expect.any(Number),
      },
      serverWriter: {
        queuedBytes: expect.any(Number),
        droppedRecords: expect.any(Number),
        writeErrors: expect.any(Number),
      },
    },
  });
});
