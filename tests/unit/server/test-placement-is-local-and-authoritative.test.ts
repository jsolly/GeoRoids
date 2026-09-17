/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { type ClientRequest, IncomingMessage, request, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import {
  handleTestArrangeCrewField,
  handleTestPlacePlayer,
  handleTestResetWorld,
} from '../../../server/testHttpHandlers';

const servers: ReturnType<typeof createServerInstance>[] = [];
const sockets: WebSocket[] = [];
const requests: ClientRequest[] = [];

afterEach(async () => {
  for (const req of requests.splice(0)) {
    req.destroy();
  }
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
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    socketUrl: `ws://127.0.0.1:${port}/ws?asteroidInteractions=1`,
  };
}

async function pilot() {
  const fixture = await start();
  const socket = new WebSocket(fixture.socketUrl);
  sockets.push(socket);
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      type: 'join',
      data: {
        id: 'fixture-pilot',
        name: 'Fixture Pilot',
        position: { x: 1700, y: 0 },
        asteroidInteractions: 1,
        snapshotVersion: 1,
      },
    })
  );
  await expect.poll(() => fixture.server.gameEngine.getPlayer('fixture-pilot')).toBeDefined();
  fixture.server.gameEngine.stopGameLoop();
  const player = fixture.server.gameEngine.getPlayer('fixture-pilot');
  if (!player) {
    throw new Error('Joined fixture pilot is absent');
  }
  return { ...fixture, socket, player };
}

function post(origin: string, body: unknown) {
  return fetch(`${origin}/test/place-player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test('production never exposes placement, crew fixtures or world reset', async () => {
  const { origin } = await start('production');
  for (const path of ['/test/place-player', '/test/reset-world', '/test/arrange-crew-field']) {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(404);
  }
});

test('development fixture controls reject a non-loopback peer', async () => {
  const { server } = await start('development');
  for (const control of ['place', 'reset', 'crew'] as const) {
    const peer = new Socket();
    Object.defineProperty(peer, 'remoteAddress', { value: '192.0.2.10' });
    const req = new IncomingMessage(peer);
    req.method = 'POST';
    const res = new ServerResponse(req);
    if (control === 'place') {
      handleTestPlacePlayer(req, res, 'development', server.gameEngine, server.wsCore);
    } else if (control === 'reset') {
      handleTestResetWorld(req, res, 'development', server.gameEngine);
    } else {
      handleTestArrangeCrewField(req, res, 'development', server.gameEngine, server.wsCore);
    }
    expect(res.statusCode).toBe(404);
    expect(res.writableEnded).toBe(true);
    peer.destroy();
  }
});

test('an invalid crew fixture leaves the connected pilot and world intact', async () => {
  const { origin, server, player } = await pilot();
  const position = { ...player.position };
  const asteroids = server.gameEngine.getAllAsteroids().map((rock) => rock.id);
  for (const body of [
    { playerIds: [], scenario: 'delivery' },
    { playerIds: [player.id], scenario: 'unknown' },
    { playerIds: [player.id], scenario: 'delivery', score: 9999 },
    { playerIds: [player.id, player.id], scenario: 'delivery' },
    { playerIds: ['missing-pilot'], scenario: 'delivery' },
  ]) {
    const response = await fetch(`${origin}/test/arrange-crew-field`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    expect(response.ok).toBe(false);
    expect(player.position).toEqual(position);
    expect(server.gameEngine.getAllAsteroids().map((rock) => rock.id)).toEqual(asteroids);
  }
});

test('invalid or oversized placement cannot change a connected pilot', async () => {
  const { origin, player } = await pilot();
  const position = { ...player.position };
  const valid = { playerId: player.id, position: { x: 1600, y: 0 } };
  for (const body of [
    null,
    [],
    { ...valid, playerId: '' },
    { ...valid, position: { x: 100001, y: 0 } },
    { ...valid, position: { x: '1600', y: 0 } },
    { ...valid, position: { x: 1600 } },
    { ...valid, health: 0 },
  ]) {
    expect((await post(origin, body)).status).toBe(400);
    expect(player.position).toEqual(position);
  }
  expect((await post(origin, { ...valid, playerId: 'x'.repeat(2000) })).status).toBe(413);
  expect(player.position).toEqual(position);
  const invalidJson = await fetch(`${origin}/test/place-player`, {
    method: 'POST',
    body: '{broken',
    signal: AbortSignal.timeout(3000),
  });
  expect(invalidJson.status).toBe(400);
  expect(player.position).toEqual(position);
});

test.each([
  { fragment: '{', expectedStatus: 408 },
  { fragment: 'x'.repeat(1100), expectedStatus: 413 },
])(
  'an unfinished request fails when it stalls or exceeds the size limit ($expectedStatus)',
  async ({ fragment, expectedStatus }) => {
    const { origin } = await start();
    const req = request(`${origin}/test/place-player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    requests.push(req);
    const response = once(req, 'response');
    req.write(fragment);
    const [res] = (await response) as [IncomingMessage];
    expect(res.statusCode).toBe(expectedStatus);
    res.resume();
  }
);

test('placement preserves health and allows subsequent legal movement', async () => {
  const { server, origin, socket, player } = await pilot();
  const previousEpoch = player.playerMotion?.epoch;
  const health = player.health;
  const position = { x: -1700, y: 0 };
  const response = await post(origin, { playerId: player.id, position });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'placed',
    playerId: player.id,
    position,
  });
  expect(player.position).toEqual(position);
  expect(player.health).toBe(health);
  const epoch = player.playerMotion?.epoch;
  assert.ok(previousEpoch !== undefined, 'previous asteroid motion epoch');
  expect(epoch).toBeGreaterThan(previousEpoch);

  const sendPose = async (x: number, motionEpoch: number | undefined, sequence: number) => {
    socket.send(
      JSON.stringify({
        type: 'update',
        data: {
          id: player.id,
          position: { x, y: 0 },
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
          motionEpoch,
          motionSequence: sequence,
        },
      })
    );
    const pong = once(socket, 'pong');
    socket.ping();
    await pong;
  };
  await sendPose(1700, previousEpoch, 99);
  expect(player.position).toEqual(position);
  await sendPose(-1699, epoch, 1);
  expect(player.position).toEqual({ x: -1699, y: 0 });
  await sendPose(9000, epoch, 2);
  expect(player.position).toEqual({ x: -1699, y: 0 });
  expect(server.gameEngine.getPlayerCount()).toBe(1);
});

test('an enhanced pilot with no motion session cannot report successful placement', async () => {
  const { server, origin, player } = await pilot();
  const position = { ...player.position };
  server.gameEngine.playerMotion.forgetActor(player.id);
  const response = await post(origin, { playerId: player.id, position: { x: -1700, y: 0 } });
  expect(response.ok).toBe(false);
  expect(player.position).toEqual(position);
});
