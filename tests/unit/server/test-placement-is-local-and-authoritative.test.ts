/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { type ClientRequest, IncomingMessage, request, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServerInstance } from '../../../server/createServer';
import {
  handleTestArrangeBotShot,
  handleTestPlacePlayer,
  handleTestResetWorld,
} from '../../../server/testHttpHandlers';
import { radiusFromMass } from '../../../shared/shipGrowth';
import { GAME, LASER } from '../../../src/constants';
import { calculateLaserStartPosition } from '../../../src/entities/ship/shipUtils';

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
  return { server, origin: `http://127.0.0.1:${port}`, socketUrl: `ws://127.0.0.1:${port}/ws` };
}

async function pilot(enhanced: boolean) {
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
        ...(enhanced ? { asteroidInteractions: 1, snapshotVersion: 1 } : {}),
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

async function post(origin: string, body: unknown) {
  return fetch(`${origin}/test/place-player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function arrange(origin: string, playerId: string, botId: string) {
  return fetch(`${origin}/test/arrange-bot-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, botId }),
    signal: AbortSignal.timeout(5000),
  });
}

test('production never exposes player placement, bot arrangement, or world reset', async () => {
  const { origin } = await start('production');
  for (const path of ['/test/place-player', '/test/arrange-bot-shot', '/test/reset-world']) {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(404);
  }
});

test('development fixture controls reject a non-loopback peer', async () => {
  const { server } = await start('development');
  for (const control of ['place', 'arrange', 'reset'] as const) {
    const peer = new Socket();
    Object.defineProperty(peer, 'remoteAddress', { value: '192.0.2.10' });
    const req = new IncomingMessage(peer);
    req.method = 'POST';
    const res = new ServerResponse(req);
    if (control === 'place') {
      handleTestPlacePlayer(req, res, 'development', server.gameEngine, server.wsCore);
    } else if (control === 'arrange') {
      handleTestArrangeBotShot(req, res, 'development', server.gameEngine, server.wsCore);
    } else {
      handleTestResetWorld(req, res, 'development', server.gameEngine);
    }
    expect(res.statusCode).toBe(404);
    expect(res.writableEnded).toBe(true);
    peer.destroy();
  }
});

test('bot arrangement rejects invalid ownership without moving either actor', async () => {
  const { server, origin, player } = await pilot(false);
  const bots = server.gameEngine.getAllBots();
  const hostile = bots.find((bot) => bot.factionId !== player.factionId);
  const friendly = bots.find((bot) => bot.factionId === player.factionId);
  expect(hostile).toBeDefined();
  expect(friendly).toBeDefined();
  if (!hostile || !friendly) {
    throw new Error('Expected both hostile and friendly fixture bots');
  }
  const playerPosition = { ...player.position };
  const hostilePosition = { ...hostile.position };
  const friendlyPosition = { ...friendly.position };

  expect((await arrange(origin, hostile.id, player.id)).status).toBe(404);
  expect((await arrange(origin, player.id, friendly.id)).status).toBe(409);
  expect((await arrange(origin, player.id, 'missing-bot')).status).toBe(404);
  expect(player.position).toEqual(playerPosition);
  expect(hostile.position).toEqual(hostilePosition);
  expect(friendly.position).toEqual(friendlyPosition);
});

test('bot arrangement changes only poses before a real authoritative laser hit', async () => {
  const { server, origin, player, socket } = await pilot(true);
  const bot = server.gameEngine
    .getAllBots()
    .find((candidate) => candidate.factionId !== player.factionId);
  expect(bot).toBeDefined();
  if (!bot) {
    throw new Error('Expected a hostile fixture bot');
  }
  const playerCombat = {
    health: player.health,
    lives: player.lives,
    score: player.score,
    factionId: player.factionId,
    spawnProtectionTimer: player.spawnProtectionTimer,
  };
  const botCombat = {
    health: bot.health,
    lives: bot.lives,
    score: bot.score,
    factionId: bot.factionId,
    spawnProtectionTimer: bot.spawnProtectionTimer,
    shieldActive: bot.shieldActive,
    shieldTime: bot.shieldTime,
  };

  const response = await arrange(origin, player.id, bot.id);
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    status: string;
    playerId: string;
    botId: string;
    playerPosition: { x: number; y: number };
    botPosition: { x: number; y: number };
  };
  expect(result).toMatchObject({ status: 'arranged', playerId: player.id, botId: bot.id });
  expect(player.position).toEqual(result.playerPosition);
  expect(bot.position).toEqual(result.botPosition);
  expect(player.velocity).toEqual({ x: 0, y: 0 });
  expect(bot.velocity).toEqual({ x: 0, y: 0 });
  expect(playerCombat).toEqual({
    health: player.health,
    lives: player.lives,
    score: player.score,
    factionId: player.factionId,
    spawnProtectionTimer: player.spawnProtectionTimer,
  });
  expect(botCombat).toEqual({
    health: bot.health,
    lives: bot.lives,
    score: bot.score,
    factionId: bot.factionId,
    spawnProtectionTimer: bot.spawnProtectionTimer,
    shieldActive: bot.shieldActive,
    shieldTime: bot.shieldTime,
  });

  const dx = bot.position.x - player.position.x;
  const dy = bot.position.y - player.position.y;
  const angle = Math.atan2(-dy, dx);
  socket.send(
    JSON.stringify({
      type: 'shoot',
      id: player.id,
      data: {
        laserStart: calculateLaserStartPosition(
          player.position,
          angle,
          radiusFromMass(player.mass)
        ),
        laserDirection: {
          x: (Math.cos(angle) * LASER.SPEED) / GAME.FPS,
          y: (-Math.sin(angle) * LASER.SPEED) / GAME.FPS,
        },
      },
    })
  );
  const pong = once(socket, 'pong');
  socket.ping();
  await pong;
  for (let frame = 0; frame < 30 && bot.health === botCombat.health; frame++) {
    server.gameEngine.advanceOneFrame();
  }
  expect(bot.health).toBe(botCombat.health - 25);
  expect(player.score).toBe(playerCombat.score);
});

test('invalid or oversized placement cannot change a connected pilot', async () => {
  const { origin, player } = await pilot(false);
  const position = { ...player.position };
  const valid = { playerId: player.id, position: { x: 1600, y: 0 } };
  for (const body of [
    null,
    [],
    { ...valid, playerId: '' },
    { ...valid, position: { x: 10001, y: 0 } },
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

test.each([false, true])(
  'placement preserves health and allows subsequent legal movement (enhanced=%s)',
  async (enhanced) => {
    const { server, origin, socket, player } = await pilot(enhanced);
    const previousEpoch = player.asteroidMotion?.epoch;
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
    const epoch = player.asteroidMotion?.epoch;
    if (enhanced) {
      assert.ok(previousEpoch !== undefined, 'previous asteroid motion epoch');
      expect(epoch).toBeGreaterThan(previousEpoch);
    }

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
    if (enhanced) {
      await sendPose(1700, previousEpoch, 99);
      expect(player.position).toEqual(position);
    }
    await sendPose(-1699, epoch, 1);
    expect(player.position).toEqual({ x: -1699, y: 0 });
    if (enhanced) {
      await sendPose(9000, epoch, 2);
      expect(player.position).toEqual({ x: -1699, y: 0 });
    }
    expect(server.gameEngine.getPlayerCount()).toBe(1);
  }
);

test('an enhanced pilot with no motion session cannot report successful placement', async () => {
  const { server, origin, player } = await pilot(true);
  const position = { ...player.position };
  server.gameEngine.asteroidMotion.forgetActor(player.id);
  const response = await post(origin, { playerId: player.id, position: { x: -1700, y: 0 } });
  expect(response.ok).toBe(false);
  expect(player.position).toEqual(position);
});
