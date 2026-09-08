/* @vitest-environment node */
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';

let server: ReturnType<typeof createServerInstance> | undefined;
const sockets: WebSocket[] = [];

function connect(port: number, path: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  socket.on('error', () => undefined);
  sockets.push(socket);
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

test('a release cutover rejects stale clients before open while updated gameplay and logs connect', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test', requireEnhancedClient: true });
  const port = await server.listening;
  const stale = connect(port, '/ws');
  let opened = false;
  stale.on('open', () => {
    opened = true;
  });
  await expect(once(stale, 'open')).rejects.toThrow('426');
  expect(opened).toBe(false);
  expect(server.gameEngine.getPlayerCount()).toBe(0);

  const updated = connect(port, '/ws?asteroidInteractions=1');
  await once(updated, 'open');
  const joined = new Promise<Record<string, unknown>>((resolve) =>
    updated.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      if (packet.type === 'joined') {
        resolve(packet.data);
      }
    })
  );
  updated.send(
    JSON.stringify({
      type: 'join',
      data: {
        id: 'current-pilot',
        name: 'Current pilot',
        snapshotVersion: 1,
        asteroidInteractions: 1,
      },
    })
  );
  expect(await joined).toMatchObject({ id: 'current-pilot', asteroidInteractions: 1 });
  const logs = connect(port, '/logs');
  await once(logs, 'open');
  expect(logs.readyState).toBe(WebSocket.OPEN);
});

test('the support release keeps ordinary clients connected before cutover is enabled', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test', requireEnhancedClient: false });
  const socket = connect(await server.listening, '/ws');
  await once(socket, 'open');
  expect(socket.readyState).toBe(WebSocket.OPEN);
});
