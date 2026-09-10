import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { ROID } from '../../../src/constants';
import { WireClient, type WireMessage } from '../../support/wireClient';

let server: ReturnType<typeof createServerInstance>;
let url: string;
const clients: WireClient[] = [];
const streams = new WeakMap<WireClient, { decoder: SnapshotDecoder; cursor: number }>();
const resumeTokens = new WeakMap<WireClient, string>();

beforeEach(async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  url = `ws://127.0.0.1:${await server.listening}/ws?asteroidInteractions=1`;
});

afterEach(async () => {
  for (const client of clients) {
    client.ws.terminate();
  }
  await server.close();
  for (const client of clients.splice(0)) {
    client.assertHealthy();
  }
});

function dataOf(message: WireMessage): Record<string, unknown> {
  assert(message.data && typeof message.data === 'object' && !Array.isArray(message.data));
  return message.data as Record<string, unknown>;
}
function asteroidIds(message: WireMessage): string[] {
  const asteroids = dataOf(message)['asteroids'];
  assert(Array.isArray(asteroids));
  return asteroids
    .map((rock: unknown) => {
      assert(rock && typeof rock === 'object' && 'id' in rock && typeof rock.id === 'string');
      return rock.id;
    })
    .sort();
}

async function waitForMessage(
  client: WireClient,
  matches: (message: WireMessage) => boolean
): Promise<WireMessage> {
  const stream = streams.get(client);
  assert(stream);
  const start = client.mark();
  let found: WireMessage | undefined;
  await expect
    .poll(
      () => {
        client.assertHealthy();
        while (stream.cursor < client.messages.length) {
          const index = stream.cursor++;
          const packet = client.messages[index];
          assert(packet);
          assert.notEqual(packet.type, 'error', String(packet.data));
          if (packet.type === 'joined') {
            stream.decoder.reset();
          }
          // Consume every recorded snapshot, even between waits, to preserve its baseline.
          const message =
            packet.type === 'snapshot'
              ? { type: packet.type, data: stream.decoder.decode(packet.data) }
              : packet;
          if (index >= start && matches(message)) {
            found = message;
            return true;
          }
        }
        return false;
      },
      { timeout: 5000 }
    )
    .toBe(true);
  assert(found);
  return found;
}

async function join(id: string, resumeToken?: string): Promise<WireClient> {
  const client = new WireClient(new WebSocket(url));
  clients.push(client);
  streams.set(client, { decoder: new SnapshotDecoder(), cursor: 0 });
  await client.open();
  const joined = waitForMessage(client, (message) => message.type === 'joined');
  client.send({
    type: 'join',
    id,
    data: { name: id, position: { x: 0, y: 0 } },
    snapshotVersion: 1,
    asteroidInteractions: 1,
    ...(resumeToken ? { resumeToken } : {}),
  });
  const ack = dataOf(await joined);
  expect(ack['id']).toBe(id);
  expect(ack['snapshotVersion']).toBe(1);
  expect(ack['asteroidInteractions']).toBe(1);
  const token = ack['resumeToken'];
  assert(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token));
  if (resumeToken) {
    expect(token).toBe(resumeToken);
  }
  resumeTokens.set(client, token);
  return client;
}

test('two pilots receive a new belt after depletion without sending asteroid initialization', async () => {
  const first = await join('belt-pilot-a');
  const second = await join('belt-pilot-b');
  const initial = server.gameEngine.getAllAsteroids();
  expect(initial).toHaveLength(ROID.INITIAL_ROID_COUNT);
  const oldIds = new Set(initial.map((asteroid) => asteroid.id));
  const replacement = (message: WireMessage): boolean => {
    if (message.type !== 'snapshot') {
      return false;
    }
    const ids = asteroidIds(message);
    return ids.length === ROID.INITIAL_ROID_COUNT && ids.every((id) => !oldIds.has(id));
  };
  const firstView = waitForMessage(first, replacement);
  const secondView = waitForMessage(second, replacement);
  // Only the running server loop rebuilds a depleted field.
  for (const asteroid of initial) {
    server.gameEngine.removeAsteroid(asteroid.id);
  }
  const [a, b] = await Promise.all([firstView, secondView]);
  expect(asteroidIds(a)).toEqual(asteroidIds(b));
  expect(server.gameEngine.getPlayerCount()).toBe(2);
});

test('a pilot briefly disconnects and resumes the same live field while its peer keeps playing', async () => {
  const first = await join('rejoin-pilot-a');
  await join('rejoin-pilot-b');
  const ids = server.gameEngine
    .getAllAsteroids()
    .map((asteroid) => asteroid.id)
    .sort();
  const token = resumeTokens.get(first);
  assert(token);
  await first.close();
  await expect.poll(() => server.gameEngine.getPlayer('rejoin-pilot-a')?.ws).toBeUndefined();
  expect(server.gameEngine.getPlayer('rejoin-pilot-a')).toBeDefined();
  const rejoined = await join('rejoin-pilot-a', token);
  const response = waitForMessage(rejoined, (message) => message.type === 'asteroidCreateBatch');
  rejoined.send({ type: 'initAsteroids', id: 'rejoin-pilot-a', data: { asteroidCount: 999999 } });
  expect(asteroidIds(await response)).toEqual(ids);
  expect(server.gameEngine.isGamePaused()).toBe(false);
  expect(server.gameEngine.getPlayerCount()).toBe(2);
});
