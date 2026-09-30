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
import {
  layoutReflectiveCluster,
  previewChargedReflections,
} from '../../../shared/asteroidPhenomena';
import { RecordingSocket } from '../../support/recordingSocket';

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
  const server = createServerInstance({ port: 0, nodeEnv, seed: 42 });
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
  for (const path of [
    '/test/place-player',
    '/test/reset-world',
    '/test/arrange-crew-field',
    '/test/fixture-state',
  ]) {
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

test('a dead pilot stays dead and placement returns its rejection evidence', async () => {
  const { origin, player } = await pilot();
  const position = { ...player.position };
  player.health = 0;
  player.exploding = true;
  const response = await post(origin, { playerId: player.id, position: { x: 9000, y: 0 } });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ reason: 'dead', health: 0, exploding: true });
  expect(player.health).toBe(0);
  expect(player.position).toEqual(position);
});

test('a crew with an unavailable motion session leaves every pose and the world intact', async () => {
  const { origin, server, player } = await pilot();
  const transport = new RecordingSocket();
  server.wsCore.handleClientMessage(
    {
      type: 'join',
      data: {
        id: 'second-pilot',
        name: 'Second pilot',
        position: { x: 1800, y: 0 },
        asteroidInteractions: 1,
        snapshotVersion: 1,
      },
    },
    transport
  );
  const second = server.gameEngine.getPlayer('second-pilot');
  assert.ok(second);
  server.gameEngine.stopGameLoop();
  const before = JSON.stringify({
    position: player.position,
    asteroids: server.gameEngine.getAllAsteroids(),
    field: server.gameEngine.getSpiderField(),
  });
  const secondPosition = { ...second.position };
  server.gameEngine.playerMotion.forgetActor(second.id);
  const response = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id, second.id], scenario: 'belt-mining' }),
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(409);
  expect(second.position).toEqual(secondPosition);
  expect(await response.json()).toEqual({ error: 'Crew fixture motion unavailable' });
  expect(
    JSON.stringify({
      position: player.position,
      asteroids: server.gameEngine.getAllAsteroids(),
      field: server.gameEngine.getSpiderField(),
    })
  ).toBe(before);
});

test('fixture evidence counts owned open transports without exposing resume credentials', async () => {
  const { origin, server, socket, player } = await pilot();
  const state = await fetch(`${origin}/test/fixture-state`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  expect(state.status).toBe(200);
  const body = await state.json();
  expect(body.sockets).toEqual({ total: 1, open: 1 });
  expect(body.players).toEqual([
    expect.objectContaining({
      id: player.id,
      health: 100,
      socketState: 1,
      motionEpoch: player.playerMotion?.epoch,
    }),
  ]);
  expect(JSON.stringify(body)).not.toMatch(/resumeToken|credential|sessionToken/u);
  const departed = once(socket, 'close');
  socket.close();
  await departed;
  await expect.poll(() => server.wss.clients.size).toBe(0);
  const after = await fetch(`${origin}/test/fixture-state`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  expect((await after.json()).sockets).toEqual({ total: 0, open: 0 });
});

test('the controlled belt scene contains its stationary identified deposit and safe pilot', async () => {
  const { origin, server, player } = await pilot();
  const response = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id], scenario: 'belt-mining' }),
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(200);
  const rocks = server.gameEngine.getAllAsteroids();
  expect(rocks).toHaveLength(1);
  expect(rocks[0]).toMatchObject({
    id: 'belt-42-60-0',
    velocity: { x: 0, y: 0 },
    angularVelocity: 0,
    health: 150,
  });
  const rock = rocks[0];
  assert.ok(rock);
  expect(Math.hypot(player.position.x - rock.position.x, player.position.y - rock.position.y)).toBe(
    450
  );
  const arranged = await response.json();
  expect(arranged.asteroidId).toBe(rock.id);
  expect(arranged.poses).toEqual([
    { playerId: player.id, position: player.position, motionEpoch: player.playerMotion?.epoch },
  ]);
});

test('a delivery fixture removes inherited cargo while preserving banked points before the tow', async () => {
  const { origin, server, player } = await pilot();
  player.cargo = 50;
  player.score = 170;
  const response = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id], scenario: 'delivery' }),
  });
  expect(response.status).toBe(200);
  expect(player.cargo).toBe(0);
  expect(player.score).toBe(170);
  player.position = { x: 0, y: 0 };
  server.gameEngine.depositCargo();
  expect(player.score).toBe(170);
});

test('a retained pilot with missing transport is rejected before crew mutation', async () => {
  const { origin, server, player } = await pilot();
  const position = { ...player.position };
  const rocks = JSON.stringify(server.gameEngine.getAllAsteroids());
  delete player.ws;
  const response = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id], scenario: 'delivery' }),
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(404);
  expect(player.position).toEqual(position);
  expect(JSON.stringify(server.gameEngine.getAllAsteroids())).toBe(rocks);
});

test('a controlled shared field keeps its identified stationary rock still while its peer drifts', async () => {
  const { origin, server, player } = await pilot();
  const response = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id], scenario: 'shared-field' }),
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    asteroidId: 'crew-fixture-shared-stationary',
    asteroidIds: ['crew-fixture-shared-stationary', 'crew-fixture-shared-moving'],
  });
  const stationary = server.gameEngine.getAsteroid('crew-fixture-shared-stationary');
  const moving = server.gameEngine.getAsteroid('crew-fixture-shared-moving');
  assert.ok(stationary);
  assert.ok(moving);
  expect(server.gameEngine.getAllAsteroids()).toHaveLength(2);
  expect(stationary.velocity).toEqual({ x: 0, y: 0 });
  expect(moving.velocity).toEqual({ x: 0.25, y: 0 });
  expect(player.position).toEqual({ x: 20_120, y: 0 });
  expect(
    Math.hypot(player.position.x - stationary.position.x, player.position.y - stationary.position.y)
  ).toBeGreaterThan(stationary.size + 50);
  const stationaryBefore = { ...stationary.position };
  const movingBefore = { ...moving.position };
  for (let frame = 0; frame < 60; frame++) {
    server.gameEngine.advanceOneFrame();
  }
  expect(stationary.position).toEqual(stationaryBefore);
  expect(moving.position.x).toBeGreaterThan(movingBefore.x + 1);
  expect(moving.position.y).toBe(movingBefore.y);
  expect(player.health).toBe(100);
});

test('fixture asteroid observations retain selected authoritative rows and reject unbounded requests', async () => {
  const { origin, server } = await pilot();
  const rock = server.gameEngine.getAllAsteroids()[0];
  assert.ok(rock);
  const selected = await fetch(`${origin}/test/fixture-state`, {
    method: 'POST',
    body: JSON.stringify({ asteroidIds: [rock.id] }),
  });
  expect(selected.status).toBe(200);
  expect((await selected.json()).observedRocks).toEqual([rock]);
  for (const asteroidIds of [
    'not-an-array',
    Array.from({ length: 31 }, () => rock.id),
    ['x'.repeat(128)],
  ]) {
    const rejected = await fetch(`${origin}/test/fixture-state`, {
      method: 'POST',
      body: JSON.stringify({ asteroidIds }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'Invalid fixture asteroid IDs' });
  }
});

test('a live pinball fixture uses canonical three-bumper geometry and rejects a dead pilot atomically', async () => {
  const { origin, server, player } = await pilot();
  const arrange = () =>
    fetch(`${origin}/test/arrange-crew-field`, {
      method: 'POST',
      body: JSON.stringify({ playerIds: [player.id], scenario: 'pinball' }),
    });
  expect((await arrange()).status).toBe(200);
  const rocks = server.gameEngine.getAllAsteroids();
  expect(rocks).toHaveLength(3);
  for (const [index, placement] of layoutReflectiveCluster({ x: 0, y: -1500 }).entries()) {
    expect(rocks[index]).toMatchObject({
      id: `crew-fixture-pinball-${index}`,
      ...placement,
      velocity: { x: 0, y: 0 },
      phenomenon: { kind: 'reflective', energy: 0 },
    });
  }
  const angle = (Math.PI * 3) / 10;
  const preview = previewChargedReflections(
    player.position,
    { x: -Math.cos(angle), y: -Math.sin(angle) },
    rocks,
    800
  );
  expect(preview.impacts.length).toBeGreaterThanOrEqual(3);
  player.health = 0;
  player.exploding = true;
  const before = JSON.stringify(rocks);
  const rejected = await arrange();
  expect(rejected.status).toBe(404);
  expect(await rejected.json()).toEqual({ error: 'Live fixture crew unavailable' });
  expect(JSON.stringify(server.gameEngine.getAllAsteroids())).toBe(before);
  expect(player.health).toBe(0);
  expect(player.exploding).toBe(true);
});

test('unrequested combat history stays empty and production cannot enable a recorder', async () => {
  const { server, player } = await pilot();
  const shot = server.gameEngine.spawnLaser(player.id, player.position, { x: 1, y: 0 });
  assert.ok(shot);
  server.gameEngine.advanceLasersAndResolveHits();
  expect(server.gameEngine.getFixtureCombatEvidence()).toEqual({ events: [], dropped: 0 });
  expect(() => server.gameEngine.observeFixtureShots('production', [player.id])).toThrow(
    'unavailable in production'
  );
  expect(server.gameEngine.getFixtureCombatEvidence()).toEqual({ events: [], dropped: 0 });
});

test('a rejected live shot retains its null admission and resetting the world clears the watch', async () => {
  const { origin, server, socket, player } = await pilot();
  const enable = await fetch(`${origin}/test/fixture-state`, {
    method: 'POST',
    body: JSON.stringify({ observePlayerShots: [player.id] }),
  });
  expect(enable.status).toBe(200);
  socket.send(
    JSON.stringify({
      type: 'shoot',
      data: {
        id: player.id,
        requestId: 'outside-hull',
        laserStart: { x: 9000, y: 9000 },
        laserDirection: { x: 1, y: 0 },
      },
    })
  );
  const pong = once(socket, 'pong');
  socket.ping();
  await pong;
  expect(server.gameEngine.getFixtureCombatEvidence().events).toContainEqual(
    expect.objectContaining({
      kind: 'admission',
      requestId: 'outside-hull',
      projectileId: null,
      rejectionReason: 'origin-or-speed-outside-budget',
      ownerId: player.id,
    })
  );
  const departure = once(socket, 'close');
  socket.close();
  await departure;
  await expect.poll(() => server.wss.clients.size).toBe(0);
  const reset = await fetch(`${origin}/test/reset-world`, { method: 'POST' });
  expect(reset.status).toBe(200);
  expect(server.gameEngine.getFixtureCombatEvidence()).toEqual({ events: [], dropped: 0 });
  const rejoinedSocket = new RecordingSocket();
  server.wsCore.handleClientMessage(
    {
      type: 'join',
      data: {
        id: player.id,
        name: 'Rejoined fixture pilot',
        asteroidInteractions: 1,
        snapshotVersion: 1,
      },
    },
    rejoinedSocket
  );
  server.gameEngine.stopGameLoop();
  const rejoined = server.gameEngine.getPlayer(player.id);
  assert.ok(rejoined);
  server.wsCore.handleClientMessage(
    {
      type: 'shoot',
      data: {
        id: rejoined.id,
        requestId: 'after-reset',
        laserStart: { ...rejoined.position },
        laserDirection: { x: 1, y: 0 },
      },
    },
    rejoinedSocket
  );
  const acknowledgement = rejoinedSocket.lastReceived('shotAcknowledged')?.data;
  expect(acknowledgement).toEqual({ requestId: 'after-reset', projectileId: expect.any(String) });
  server.gameEngine.advanceLasersAndResolveHits();
  expect(server.gameEngine.getFixtureCombatEvidence()).toEqual({ events: [], dropped: 0 });
});
