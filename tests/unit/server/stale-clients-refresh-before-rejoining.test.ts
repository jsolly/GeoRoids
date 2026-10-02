/* @vitest-environment node */

import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';

let server: ReturnType<typeof createServerInstance> | undefined;
const sockets: WebSocket[] = [];

function connect(port: number, path: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  socket.on('error', () => undefined);
  sockets.push(socket);
  return socket;
}

function receive(socket: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`Timed out awaiting ${type}`)), 5000);
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', message);
      socket.off('close', closed);
      socket.off('error', fail);
    }
    function fail(error: Error) {
      cleanup();
      reject(error);
    }
    function closed() {
      fail(new Error(`Socket closed before ${type}`));
    }
    function message(raw: unknown) {
      try {
        const packet: unknown = JSON.parse(String(raw));
        if (
          typeof packet === 'object' &&
          packet !== null &&
          'type' in packet &&
          packet.type === type
        ) {
          cleanup();
          resolve(packet);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
    socket.on('message', message);
    socket.once('close', closed);
    socket.once('error', fail);
  });
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

test('the server rejects stale gameplay clients before open and accepts a refreshed pilot', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const port = await server.listening;
  for (const path of [
    '/ws',
    '/ws?asteroidInteractions=1',
    '/ws?snapshotVersion=1&asteroidInteractions=1',
    '/other?snapshotVersion=1&asteroidInteractions=1',
    `/ws?snapshotVersion=${SNAPSHOT_VERSION + 1}&asteroidInteractions=1`,
    `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=2`,
  ]) {
    const stale = connect(port, path);
    let opened = false;
    stale.on('open', () => {
      opened = true;
    });
    await expect(once(stale, 'open')).rejects.toThrow('426');
    expect(opened).toBe(false);
    expect(server.gameEngine.getPlayerCount()).toBe(0);
  }

  const updated = connect(port, `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`);
  await once(updated, 'open');
  const joined = receive(updated, 'joined');
  updated.send(
    JSON.stringify({
      type: 'join',
      data: {
        id: 'current-pilot',
        name: 'Current pilot',
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
      },
    })
  );
  expect(await joined).toMatchObject({
    type: 'joined',
    data: {
      id: 'current-pilot',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
    },
  });
  const logs = connect(port, '/logs');
  await once(logs, 'open');
  expect(logs.readyState).toBe(WebSocket.OPEN);
});

test('a current gameplay socket rejects missing, retired and future snapshot join offers', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const port = await server.listening;
  for (const offer of [undefined, 1, SNAPSHOT_VERSION + 1, String(SNAPSHOT_VERSION)]) {
    const socket = connect(port, `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`);
    await once(socket, 'open');
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const error = receive(socket, 'error');
    socket.send(
      JSON.stringify({
        type: 'join',
        data: {
          id: 'stale-pilot',
          name: 'Stale pilot',
          asteroidInteractions: 1,
          ...(offer === undefined ? {} : { snapshotVersion: offer }),
        },
      })
    );
    await expect(error).resolves.toMatchObject({
      type: 'error',
      data: 'Client update required; refresh GeoRoids',
    });
    expect(server.gameEngine.getPlayerCount()).toBe(0);
  }
});
