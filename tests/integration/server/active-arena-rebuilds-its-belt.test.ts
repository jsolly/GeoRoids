import { once } from 'node:events';
import { afterEach, beforeEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';

type Message = {
  type: string;
  data: { asteroids?: AsteroidData[]; id?: string };
};

let server: ReturnType<typeof createServerInstance>;
let url: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  url = `ws://127.0.0.1:${await server.listening}/ws`;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await server.close();
});

function waitForMessage(
  socket: WebSocket,
  matches: (message: Message) => boolean
): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Expected authoritative server message did not arrive'));
    }, 5000);
    function onMessage(raw: WebSocket.RawData): void {
      const message = JSON.parse(String(raw)) as Message;
      if (!matches(message)) {
        return;
      }
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

async function join(id: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await once(socket, 'open');
  const joined = waitForMessage(socket, (message) => message.type === 'joined');
  socket.send(
    JSON.stringify({
      type: 'join',
      id,
      data: { name: id, position: { x: 0, y: 0 } },
      timestamp: Date.now(),
    })
  );
  await joined;
  return socket;
}

test('two pilots receive a new belt after depletion without sending asteroid initialization', async () => {
  const first = await join('belt-pilot-a');
  const second = await join('belt-pilot-b');
  const initial = server.gameEngine.getAllAsteroids();
  expect(initial).toHaveLength(ROID.INITIAL_ROID_COUNT);
  const oldIds = new Set(initial.map((asteroid) => asteroid.id));
  const replacement = (message: Message): boolean =>
    message.type === 'gameState' &&
    message.data.asteroids?.length === ROID.INITIAL_ROID_COUNT &&
    message.data.asteroids.every((asteroid) => !oldIds.has(asteroid.id));
  const firstView = waitForMessage(first, replacement);
  const secondView = waitForMessage(second, replacement);

  // Simulate depletion at the internal world seam; clients cannot manufacture
  // this state with an init request. The normal running loop must refill it.
  for (const asteroid of initial) {
    server.gameEngine.removeAsteroid(asteroid.id);
  }
  const [a, b] = await Promise.all([firstView, secondView]);
  expect(a.data.asteroids?.map((asteroid) => asteroid.id).sort()).toEqual(
    b.data.asteroids?.map((asteroid) => asteroid.id).sort()
  );
  expect(server.gameEngine.getPlayerCount()).toBe(2);
});

test('a pilot briefly disconnects and rejoins the same live field while its peer keeps playing', async () => {
  const first = await join('rejoin-pilot-a');
  const second = await join('rejoin-pilot-b');
  const ids = server.gameEngine
    .getAllAsteroids()
    .map((asteroid) => asteroid.id)
    .sort();
  const peerLeft = waitForMessage(
    second,
    (message) => message.type === 'playerLeft' && message.data.id === 'rejoin-pilot-a'
  );
  first.close();
  await peerLeft;
  const rejoined = await join('rejoin-pilot-a');
  const response = waitForMessage(rejoined, (message) => message.type === 'asteroidCreateBatch');
  rejoined.send(
    JSON.stringify({
      type: 'initAsteroids',
      id: 'rejoin-pilot-a',
      data: { asteroidCount: 999999 },
      timestamp: Date.now(),
    })
  );
  const batch = await response;
  expect(batch.data.asteroids?.map((asteroid) => asteroid.id).sort()).toEqual(ids);
  expect(server.gameEngine.isGamePaused()).toBe(false);
  expect(server.gameEngine.getPlayerCount()).toBe(2);
});
