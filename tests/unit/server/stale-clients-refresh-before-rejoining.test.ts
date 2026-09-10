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

test('the server rejects stale gameplay clients before open and accepts the current handshake', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
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

test('a current gameplay socket still requires the snapshot capability in its join offer', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const socket = connect(await server.listening, '/ws?asteroidInteractions=1');
  await once(socket, 'open');
  expect(socket.readyState).toBe(WebSocket.OPEN);
  const error = new Promise<Record<string, unknown>>((resolve) =>
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw));
      if (packet.type === 'error') {
        resolve(packet);
      }
    })
  );
  socket.send(
    JSON.stringify({
      type: 'join',
      data: { id: 'stale-pilot', name: 'Stale pilot', asteroidInteractions: 1 },
    })
  );
  await expect(error).resolves.toMatchObject({
    type: 'error',
    data: 'Client update required; refresh GeoRoids',
  });
  expect(server.gameEngine.getPlayerCount()).toBe(0);
});
