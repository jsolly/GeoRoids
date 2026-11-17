/* @vitest-environment node */

import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

let server: ReturnType<typeof createServerInstance> | undefined;
const clients: WireClient[] = [];
const rejected = new Set<WireClient>();
function connect(port: number, path: string): WireClient {
  const client = new WireClient(new WebSocket(`ws://127.0.0.1:${port}${path}`));
  clients.push(client);
  return client;
}
function receive(client: WireClient, type: string): Promise<unknown> {
  const after = client.mark();
  return client.waitFor(
    () => client.messages.slice(after).find((message) => message.type === type),
    type,
    5000
  );
}
afterEach(async () => {
  try {
    await closePlayerMotionScenario({
      clients: clients.map((client) => ({
        async close() {
          await client.close();
          if (!rejected.has(client)) {
            client.assertHealthy();
          }
        },
      })),
      server,
    });
  } finally {
    clients.length = 0;
    rejected.clear();
    server = undefined;
  }
});

test('the server rejects stale gameplay clients before open and accepts a refreshed pilot', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const port = await server.listening;
  for (const path of [
    '/ws',
    '/ws?asteroidInteractions=1&explorationVersion=1',
    '/ws?snapshotVersion=1&asteroidInteractions=1&explorationVersion=1',
    '/ws?snapshotVersion=2&asteroidInteractions=1&explorationVersion=1',
    '/other?snapshotVersion=1&asteroidInteractions=1&explorationVersion=1',
    `/ws?snapshotVersion=${SNAPSHOT_VERSION + 1}&asteroidInteractions=1&explorationVersion=1`,
    `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=2`,
    `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`,
    `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1&explorationVersion=2`,
  ]) {
    const stale = connect(port, path);
    let opened = false;
    stale.ws.on('open', () => {
      opened = true;
    });
    rejected.add(stale);
    await expect(stale.open()).rejects.toThrow('426');
    expect(stale.failures).toHaveLength(1);
    expect(stale.failures[0]?.message).toContain('426');
    expect(opened).toBe(false);
    expect(server.gameEngine.getPlayerCount()).toBe(0);
  }

  const updated = connect(
    port,
    `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1&explorationVersion=1`
  );
  await updated.open();
  const joined = receive(updated, 'joined');
  updated.send({
    type: 'join',
    data: {
      id: 'current-pilot',
      name: 'Current pilot',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      explorationVersion: 1,
    },
  });
  expect(await joined).toMatchObject({
    type: 'joined',
    data: {
      id: 'current-pilot',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      explorationVersion: 1,
    },
  });
  const logs = connect(port, '/logs');
  await logs.open();
  expect(logs.ws.readyState).toBe(WebSocket.OPEN);
});

test('a current gameplay socket rejects missing, retired and future snapshot join offers', async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const port = await server.listening;
  for (const offer of [undefined, 1, 2, SNAPSHOT_VERSION + 1, String(SNAPSHOT_VERSION)]) {
    const socket = connect(
      port,
      `/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1&explorationVersion=1`
    );
    await socket.open();
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    const error = receive(socket, 'error');
    socket.send({
      type: 'join',
      data: {
        id: 'stale-pilot',
        name: 'Stale pilot',
        asteroidInteractions: 1,
        explorationVersion: 1,
        ...(offer === undefined ? {} : { snapshotVersion: offer }),
      },
    });
    await expect(error).resolves.toMatchObject({
      type: 'error',
      data: 'Client update required; refresh GeoRoids',
    });
    expect(server.gameEngine.getPlayerCount()).toBe(0);
  }
});
