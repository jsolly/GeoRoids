/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { type ClientRequest, IncomingMessage, request, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
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

async function pilot(kitId: 'scout' | 'hauler' = 'scout') {
  const fixture = await start();
  const socket = new WebSocket(fixture.socketUrl);
  sockets.push(socket);
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      type: 'join',
      data: {
        id: 'fixture-pilot',
        kitId,
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
      body: JSON.stringify({
        playerId: 'fixture-pilot',
        position: { x: 1800, y: 0 },
        clearSpawnProtection: true,
        expectedTowTargetId: 'live-spider',
      }),
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(404);
  }
});

test('development fixture controls reject a non-loopback peer', async () => {
  const { server, player } = await pilot();
  player.spawnProtectionTimer = 321;
  const health = player.health;
  for (const control of ['place', 'reset', 'crew'] as const) {
    const peer = new Socket();
    Object.defineProperty(peer, 'remoteAddress', { value: '192.0.2.10' });
    const req = new IncomingMessage(peer);
    req.method = 'POST';
    req.push(
      JSON.stringify({
        playerId: player.id,
        position: { x: 1800, y: 0 },
        clearSpawnProtection: true,
      })
    );
    req.push(null);
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
    expect(player.spawnProtectionTimer).toBe(321);
    expect(player.health).toBe(health);
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

test('explicit combat release preserves health and absent or false release preserves protection', async () => {
  const { origin, player } = await pilot();
  player.spawnProtectionTimer = 321;
  const health = player.health;
  for (const option of [{}, { clearSpawnProtection: false }]) {
    const response = await post(origin, {
      playerId: player.id,
      position: { x: 1700, y: 0 },
      ...option,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      spawnProtectionCleared: false,
      spawnProtectionTimer: 321,
    });
    expect(player.spawnProtectionTimer).toBe(321);
    expect(player.health).toBe(health);
  }
  const response = await post(origin, {
    playerId: player.id,
    position: { x: 1800, y: 0 },
    clearSpawnProtection: true,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    spawnProtectionCleared: true,
    spawnProtectionTimer: 0,
    position: { x: 1800, y: 0 },
    motionEpoch: player.playerMotion?.epoch,
  });
  expect(player.health).toBe(health);
  expect(player.spawnProtectionTimer).toBe(0);
});

test('malformed release and unavailable actors cannot mutate placement, health or protection', async () => {
  const { origin, player, socket } = await pilot();
  player.spawnProtectionTimer = 321;
  const before = {
    position: { ...player.position },
    health: player.health,
    protection: player.spawnProtectionTimer,
    epoch: player.playerMotion?.epoch,
  };
  for (const flag of [null, 1, 'true', {}, []]) {
    expect(
      (
        await post(origin, {
          playerId: player.id,
          position: { x: 1900, y: 0 },
          clearSpawnProtection: flag,
        })
      ).status
    ).toBe(400);
    expect({
      position: player.position,
      health: player.health,
      protection: player.spawnProtectionTimer,
      epoch: player.playerMotion?.epoch,
    }).toEqual(before);
  }
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: { x: 1900, y: 0 },
        clearSpawnProtection: true,
        extra: true,
      })
    ).status
  ).toBe(400);
  player.health = 0;
  player.exploding = true;
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: { x: 1900, y: 0 },
        clearSpawnProtection: true,
      })
    ).status
  ).toBe(404);
  expect(player.position).toEqual(before.position);
  expect(player.spawnProtectionTimer).toBe(321);
  expect(player.health).toBe(0);
  player.health = before.health;
  player.exploding = false;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: { x: 1900, y: 0 },
        clearSpawnProtection: true,
      })
    ).status
  ).toBe(404);
  expect(player.position).toEqual(before.position);
  expect(player.spawnProtectionTimer).toBe(321);
});

test('finite tow admission preserves health and cooldown, then atomic release allows normal lethal spider bites', async () => {
  const { origin, player, server } = await pilot('hauler');
  player.abilityCooldownFrames = 17;
  const health = player.health;
  const arranged = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id], scenario: 'spider-tow-bite' }),
  });
  expect(arranged.status).toBe(200);
  expect(player.health).toBe(health);
  expect(player.spawnProtectionTimer).toBe(600);
  expect(player.abilityCooldownFrames).toBe(17);
  for (let frame = 0; frame < 20; frame++) {
    server.gameEngine.advanceOneFrame();
  }
  expect(player.health).toBe(health);
  expect(server.gameEngine.useAbility(player.id)).toBe(true);
  const spiderId = player.harpoonTargetId;
  assert.ok(spiderId);
  const spider = server.gameEngine.getSpiderField().spiders.find((body) => body.id === spiderId);
  assert.ok(spider);
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: spider.position,
        expectedTowTargetId: spiderId,
      })
    ).status
  ).toBe(200);
  expect(player.harpoonTargetId).toBe(spiderId);
  server.gameEngine.advanceOneFrame();
  expect(player.health).toBe(health);
  const release = await post(origin, {
    playerId: player.id,
    position: spider.position,
    clearSpawnProtection: true,
    expectedTowTargetId: spiderId,
  });
  expect(release.status).toBe(200);
  expect(await release.json()).toMatchObject({
    spawnProtectionCleared: true,
    spawnProtectionTimer: 0,
    expectedTowTargetId: spiderId,
    towOwnerId: player.id,
    towTargetId: spiderId,
    placedActorTowTargetId: spiderId,
  });
  expect(player.harpoonTargetId).toBe(spiderId);
  expect(player.health).toBe(health);
  // Normal protected attacks retain their cooldown; release does not reset it.
  server.gameEngine.advanceOneFrame();
  expect(player.health).toBe(health);
  const attacks: { spiderId: string; targetId: string; attackerId: string; towed: boolean }[] = [];
  const originalAdvance = TerrainSpiderManager.prototype.advance;
  vi.spyOn(TerrainSpiderManager.prototype, 'advance').mockImplementation(function (
    this: TerrainSpiderManager,
    options
  ) {
    const result = originalAdvance.call(this, options);
    for (const attack of result) {
      attacks.push({
        ...attack,
        towed:
          options.towedIds?.has(attack.spiderId) === true &&
          options.spiderTows?.some(
            (tow) => tow.ownerId === player.id && tow.spiderId === attack.spiderId
          ) === true,
      });
    }
    return result;
  });
  const combat: unknown[] = [];
  server.gameEngine.setCombatSink((result) => combat.push(result));
  expect(server.gameEngine.getSpiderField().spiders.filter((body) => body.health > 0)).toHaveLength(
    1
  );
  for (let frame = 0; frame < 180 && player.health > 0; frame++) {
    expect(player.harpoonTargetId).toBe(spiderId);
    server.gameEngine.advanceOneFrame();
  }
  expect(attacks).toContainEqual({
    spiderId,
    targetId: player.id,
    attackerId: 'spider',
    towed: true,
  });
  expect(combat).toContainEqual(
    expect.objectContaining({
      targetId: player.id,
      attackerId: 'spider',
      remainingHealth: 0,
      isDestroyed: true,
    })
  );
  expect(player.deathCause).toBe('spider');
  expect(player.health).toBe(0);
  expect(player.exploding).toBe(true);
});

test('tow-preserving placement rejects invalid identity or target before mutation and default placement still clears tow', async () => {
  const { origin, player, server } = await pilot('hauler');
  const arranged = await fetch(`${origin}/test/arrange-crew-field`, {
    method: 'POST',
    body: JSON.stringify({ playerIds: [player.id], scenario: 'spider-tow-bite' }),
  });
  expect(arranged.status).toBe(200);
  expect(server.gameEngine.useAbility(player.id)).toBe(true);
  const target = player.harpoonTargetId;
  assert.ok(target);
  const observe = () =>
    JSON.stringify({
      position: player.position,
      health: player.health,
      protection: player.spawnProtectionTimer,
      motion: player.playerMotion,
      active: player.abilityActiveFrames,
      target: player.harpoonTargetId,
      latch: player.harpoonLatchPos,
    });
  const before = observe();
  for (const expectedTowTargetId of [undefined, '', null, 3, {}, [], 'missing-spider']) {
    const response = await post(origin, {
      playerId: player.id,
      position: { x: 4500, y: 2200 },
      clearSpawnProtection: true,
      expectedTowTargetId,
    });
    expect(response.ok).toBe(false);
    expect(observe()).toBe(before);
  }
  expect(
    server.gameEngine.playerMotion.placeTowedActorForTesting(
      { ...player },
      { x: 4500, y: 2200 },
      server.gameEngine.getServerTime(),
      target
    )
  ).toBe(false);
  expect(observe()).toBe(before);
  player.haulerUtility = 'boost_coupling';
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: { x: 4500, y: 2200 },
        clearSpawnProtection: true,
        expectedTowTargetId: target,
      })
    ).ok
  ).toBe(false);
  expect(observe()).toBe(before);
  player.haulerUtility = 'tow_cable';
  const spiderField = server.gameEngine.getSpiderField();
  const dead = vi.spyOn(server.gameEngine, 'getSpiderField').mockReturnValue({
    ...spiderField,
    spiders: spiderField.spiders.map((spider) => ({ ...spider, health: 0 })),
  });
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: { x: 4500, y: 2200 },
        clearSpawnProtection: true,
        expectedTowTargetId: target,
      })
    ).ok
  ).toBe(false);
  expect(observe()).toBe(before);
  dead.mockRestore();
  const defaultPlacement = await post(origin, {
    playerId: player.id,
    position: { x: 4500, y: 2200 },
  });
  expect(defaultPlacement.status).toBe(200);
  expect(player.harpoonTargetId).toBeNull();
  expect(player.harpoonLatchPos).toBeUndefined();
  expect(player.abilityActiveFrames).toBe(0);
  expect(player.spawnProtectionTimer).toBe(600);
});

test('a missing owner motion session rejects tow-preserving release without changing pose or immunity', async () => {
  const { origin, player, server } = await pilot('hauler');
  expect(
    (
      await fetch(`${origin}/test/arrange-crew-field`, {
        method: 'POST',
        body: JSON.stringify({ playerIds: [player.id], scenario: 'spider-tow-bite' }),
      })
    ).status
  ).toBe(200);
  expect(server.gameEngine.useAbility(player.id)).toBe(true);
  const target = player.harpoonTargetId;
  assert.ok(target);
  server.gameEngine.playerMotion.forgetActor(player.id);
  const before = {
    position: { ...player.position },
    health: player.health,
    protection: player.spawnProtectionTimer,
    epoch: player.playerMotion?.epoch,
    target,
  };
  expect(
    (
      await post(origin, {
        playerId: player.id,
        position: { x: 4500, y: 2200 },
        clearSpawnProtection: true,
        expectedTowTargetId: target,
      })
    ).ok
  ).toBe(false);
  expect({
    position: player.position,
    health: player.health,
    protection: player.spawnProtectionTimer,
    epoch: player.playerMotion?.epoch,
    target: player.harpoonTargetId,
  }).toEqual(before);
});

test('explicit tow release rejects stale victim or owner actor identity without mutating either current session', async () => {
  const { origin, player, server } = await pilot('hauler');
  expect(
    (
      await fetch(`${origin}/test/arrange-crew-field`, {
        method: 'POST',
        body: JSON.stringify({ playerIds: [player.id], scenario: 'spider-tow-bite' }),
      })
    ).status
  ).toBe(200);
  expect(server.gameEngine.useAbility(player.id)).toBe(true);
  const target = player.harpoonTargetId;
  assert.ok(target);
  const witnessSocket = new RecordingSocket();
  server.wsCore.handleClientMessage(
    {
      type: 'join',
      data: {
        id: 'fixture-witness',
        name: 'Witness',
        kitId: 'scout',
        position: { x: 4400, y: 2800 },
        asteroidInteractions: 1,
        snapshotVersion: 1,
      },
    },
    witnessSocket
  );
  server.gameEngine.stopGameLoop();
  const witness = server.gameEngine.getPlayer('fixture-witness');
  assert.ok(witness);
  const state = () =>
    JSON.stringify(
      [player, witness].map((actor) => ({
        position: actor.position,
        health: actor.health,
        protection: actor.spawnProtectionTimer,
        motion: actor.playerMotion,
        target: actor.harpoonTargetId,
        active: actor.abilityActiveFrames,
        latch: actor.harpoonLatchPos,
      }))
    );
  const before = state();
  const getPlayer = server.gameEngine.getPlayer.bind(server.gameEngine);
  for (const stale of [player, witness]) {
    const lookup = vi
      .spyOn(server.gameEngine, 'getPlayer')
      .mockImplementation((id) => (id === stale.id ? { ...stale } : getPlayer(id)));
    expect(
      (
        await post(origin, {
          playerId: stale.id,
          position: { x: 4500, y: 2200 },
          clearSpawnProtection: true,
          expectedTowTargetId: target,
        })
      ).ok
    ).toBe(false);
    expect(state()).toBe(before);
    lookup.mockRestore();
  }
  // A second real live Tow Cable session claiming the captive is ambiguous.
  witness.kitId = 'hauler';
  witness.haulerUtility = 'tow_cable';
  witness.harpoonTargetId = target;
  const ambiguous = state();
  for (const actor of [player, witness]) {
    expect(
      (
        await post(origin, {
          playerId: actor.id,
          position: { x: 4500, y: 2200 },
          clearSpawnProtection: true,
          expectedTowTargetId: target,
        })
      ).ok
    ).toBe(false);
    expect(state()).toBe(ambiguous);
  }
  // A passer carrying a different latch is never ordinary-placed by this path.
  witness.harpoonTargetId = 'another-target';
  const carrying = state();
  expect(
    (
      await post(origin, {
        playerId: witness.id,
        position: { x: 4500, y: 2200 },
        clearSpawnProtection: true,
        expectedTowTargetId: target,
      })
    ).ok
  ).toBe(false);
  expect(state()).toBe(carrying);
  witness.harpoonTargetId = null;
  server.gameEngine.playerMotion.forgetActor(player.id);
  const afterForget = state();
  expect(
    (
      await post(origin, {
        playerId: witness.id,
        position: { x: 4500, y: 2200 },
        clearSpawnProtection: true,
        expectedTowTargetId: target,
      })
    ).ok
  ).toBe(false);
  expect(state()).toBe(afterForget);
});
