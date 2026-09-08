/* @vitest-environment node */
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { ClientLogger } from '../../../server/services/ClientLogger';

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
  expect(code).toBe(1008);
});

test('malformed JSON and wrong log envelopes count as rejected ingress without being accepted', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const before = ClientLogger.getDiagnostics();
  for (const [frame, expectedCode] of [
    ['{broken', 1007],
    [JSON.stringify({ type: 'unexpected', data: { message: 'discard this' } }), 1008],
  ] as const) {
    const socket = await connect('/logs');
    const closed = once(socket, 'close');
    socket.send(frame);
    expect((await closed)[0]).toBe(expectedCode);
  }
  const after = ClientLogger.getDiagnostics();
  expect(after.invalid).toBe(before.invalid + 2);
  expect(after.accepted).toBe(before.accepted);
});
