/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { WireClient, type WireMessage } from '../../support/wireClient';

type TestServer = ReturnType<typeof createServerInstance>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageData(message: WireMessage): Record<string, unknown> {
  assert.ok(isRecord(message.data), `${message.type} message data must be an object`);
  return message.data;
}

function asteroidIds(message: WireMessage): string[] {
  const rawAsteroids = messageData(message)['asteroids'];
  assert.ok(Array.isArray(rawAsteroids), 'asteroidCreateBatch must contain an array');
  return rawAsteroids.map((rawAsteroid, index) => {
    assert.ok(isRecord(rawAsteroid), `fragment ${index} must be an object`);
    const id = rawAsteroid['id'];
    assert.ok(typeof id === 'string', `fragment ${index} must have an id`);
    return id;
  });
}

function messageAt(client: WireClient, type: string, start = 0): WireMessage {
  const message = client.messages.slice(start).find((candidate) => candidate.type === type);
  assert.ok(
    message,
    `expected ${type} after message ${start}; saw ${client.messages
      .slice(start)
      .map((candidate) => candidate.type)
      .join(', ')}`
  );
  return message;
}

async function join(
  client: WireClient,
  id: string,
  position: { x: number; y: number }
): Promise<void> {
  const start = client.mark();
  client.send({
    type: 'join',
    id,
    name: id,
    position,
    snapshotVersion: 1,
    asteroidInteractions: 1,
  });
  await client.barrier();
  const joined = messageAt(client, 'joined', start);
  expect(messageData(joined)['id']).toBe(id);
}

let activeServer: TestServer | undefined;
const activeClients: WireClient[] = [];

async function connect(server: TestServer): Promise<WireClient> {
  const client = new WireClient(
    new WebSocket(`ws://127.0.0.1:${await server.listening}/ws?asteroidInteractions=1`)
  );
  activeClients.push(client);
  await client.open();
  return client;
}

async function startWorld(
  pilots: ReadonlyArray<{ id: string; position: { x: number; y: number } }>
): Promise<{ server: TestServer; clients: WireClient[] }> {
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  activeServer = server;
  await server.listening;
  server.gameEngine.stopGameLoop();
  server.wsCore.stopPeriodicGameStateBroadcast();

  const clients: WireClient[] = [];
  for (const pilot of pilots) {
    const client = await connect(server);
    await join(client, pilot.id, pilot.position);
    clients.push(client);
  }
  await Promise.all(clients.map((client) => client.barrier()));

  for (const bot of server.gameEngine.getAllBots()) {
    server.gameEngine.removeBot(bot.id);
  }
  for (const asteroid of server.gameEngine.getAllAsteroids()) {
    server.gameEngine.removeAsteroid(asteroid.id);
  }
  for (const satelliteSnapshot of server.gameEngine.getAllSatellites()) {
    const satellite = server.gameEngine.getSatellite(satelliteSnapshot.id);
    assert.ok(satellite, `live satellite ${satelliteSnapshot.id}`);
    satellite.position = { x: -2_400, y: -2_400 };
  }
  expect(server.gameEngine.getLoot()).toEqual([]);
  expect(server.gameEngine.getActiveSatelliteProjectiles()).toEqual([]);

  return { server, clients };
}

function largeIceAsteroid(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 50,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 50,
    maxHealth: 50,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    material: 'ice',
  };
}

async function sendCurrentShot(
  server: TestServer,
  client: WireClient,
  playerId: string,
  asteroidId: string
): Promise<void> {
  const asteroid = server.gameEngine.getAsteroid(asteroidId);
  assert.ok(asteroid, `asteroid ${asteroidId}`);
  const shooter = server.gameEngine.getPlayer(playerId);
  assert.ok(shooter, `shooter ${playerId}`);
  const delta = {
    x: asteroid.position.x - shooter.position.x,
    y: asteroid.position.y - shooter.position.y,
  };
  const distance = Math.hypot(delta.x, delta.y);
  const direction =
    distance > 0 ? { x: delta.x / distance, y: delta.y / distance } : { x: 1, y: 0 };
  const laserStart = {
    x: shooter.position.x - direction.x * 10,
    y: shooter.position.y - direction.y * 10,
  };
  client.send({
    type: 'shoot',
    id: playerId,
    data: {
      laserStart,
      laserDirection: { x: direction.x * 5, y: direction.y * 5 },
    },
  });
  await client.barrier();
  for (let frame = 0; frame < 200 && server.gameEngine.getServerLasers().length > 0; frame++) {
    server.gameEngine.advanceOneFrame();
  }
  await client.barrier();
  expect(server.gameEngine.getServerLasers()).toHaveLength(0);
}

function countType(client: WireClient, type: string): number {
  return client.messages.filter((message) => message.type === type).length;
}

afterEach(async () => {
  try {
    await activeServer?.close();
    for (const client of activeClients) {
      client.assertHealthy();
    }
  } finally {
    activeServer = undefined;
    activeClients.length = 0;
  }
});

describe('Scenario: two players hit a big roid within 1s → split', () => {
  test('real owners tag then split one large ice roid and broadcast one shockwave', async () => {
    const { server, clients } = await startWorld([
      { id: 'player-a', position: { x: 0, y: 0 } },
      { id: 'player-b', position: { x: 200, y: 0 } },
    ]);
    const [playerA, playerB] = clients;
    assert.ok(playerA, 'player A socket');
    assert.ok(playerB, 'player B socket');
    const target = largeIceAsteroid('wire-collab-target', { x: 100, y: 0 });
    server.gameEngine.addAsteroid(target);
    playerA.resetMessages();
    playerB.resetMessages();

    const now = Date.now();
    const clock = vi.spyOn(server.gameEngine, 'getServerTime').mockReturnValue(now);
    try {
      const firstAStart = playerA.mark();
      const firstBStart = playerB.mark();
      await sendCurrentShot(server, playerA, 'player-a', target.id);
      await playerB.barrier();
      const firstTagA = messageAt(playerA, 'asteroidTagged', firstAStart);
      const firstTagB = messageAt(playerB, 'asteroidTagged', firstBStart);
      expect(firstTagA.data).toEqual({
        asteroidId: target.id,
        shooterId: 'player-a',
        expiresAt: now + ROID.COLLAB_SPLIT_WINDOW_MS,
      });
      expect(firstTagB.data).toEqual(firstTagA.data);
      expect(countType(playerA, 'asteroidDestroy')).toBe(0);
      expect(countType(playerA, 'asteroidCreateBatch')).toBe(0);
      expect(countType(playerA, 'scoreUpdate')).toBe(0);
      expect(server.gameEngine.getAsteroid(target.id)).toBeDefined();
      expect(server.gameEngine.getPlayer('player-a')?.score).toBe(0);

      const secondAStart = playerA.mark();
      const secondBStart = playerB.mark();
      await sendCurrentShot(server, playerB, 'player-b', target.id);
      await playerA.barrier();
      const destroyA = messageAt(playerA, 'asteroidDestroy', secondAStart);
      const destroyB = messageAt(playerB, 'asteroidDestroy', secondBStart);
      const shockwaveA = messageAt(playerA, 'shockwave', secondAStart);
      const shockwaveB = messageAt(playerB, 'shockwave', secondBStart);
      const createA = messageAt(playerA, 'asteroidCreateBatch', secondAStart);
      const createB = messageAt(playerB, 'asteroidCreateBatch', secondBStart);
      const scoreA = messageAt(playerA, 'scoreUpdate', secondAStart);
      const scoreB = messageAt(playerB, 'scoreUpdate', secondBStart);

      expect(destroyA.data).toEqual({
        asteroidId: target.id,
        collabSplit: true,
        origin: target.position,
      });
      expect(destroyB.data).toEqual(destroyA.data);
      expect(shockwaveA.data).toEqual({ origin: target.position, asteroidId: target.id });
      expect(shockwaveB.data).toEqual(shockwaveA.data);
      expect(scoreA.data).toEqual({ playerId: 'player-b', score: ROID.POINTS_LARGE });
      expect(scoreB.data).toEqual(scoreA.data);
      const fragmentsA = asteroidIds(createA);
      const fragmentsB = asteroidIds(createB);
      expect(fragmentsA).toHaveLength(2);
      expect(new Set(fragmentsA).size).toBe(2);
      expect(fragmentsB).toEqual(fragmentsA);
      expect(countType(playerA, 'asteroidDestroy')).toBe(1);
      expect(countType(playerA, 'asteroidCreateBatch')).toBe(1);
      expect(countType(playerA, 'shockwave')).toBe(1);
      expect(countType(playerA, 'scoreUpdate')).toBe(1);
      expect(server.gameEngine.getAsteroid(target.id)).toBeUndefined();
      expect(server.gameEngine.getPlayer('player-b')?.score).toBe(ROID.POINTS_LARGE);
      expect(playerA.failures).toEqual([]);
      expect(playerB.failures).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  test('a forged second shooter claim on the owner socket is ignored', async () => {
    const { server, clients } = await startWorld([
      { id: 'socket-owner', position: { x: 0, y: 0 } },
    ]);
    const [client] = clients;
    assert.ok(client, 'owner socket');
    const target = largeIceAsteroid('wire-forged-target', { x: 100, y: 0 });
    server.gameEngine.addAsteroid(target);
    client.resetMessages();

    const validStart = client.mark();
    await sendCurrentShot(server, client, 'socket-owner', target.id);
    const validTag = messageAt(client, 'asteroidTagged', validStart);
    expect(messageData(validTag)['asteroidId']).toBe(target.id);
    client.resetMessages();

    client.send({
      type: 'shoot',
      id: 'forged-partner',
      data: {
        laserStart: { ...target.position },
        laserDirection: { x: 0, y: 0 },
      },
    });
    await client.barrier();

    expect(client.messages).toEqual([]);
    expect(server.gameEngine.getAsteroid(target.id)).toBeDefined();
    expect(server.gameEngine.getPlayer('socket-owner')?.score).toBe(0);
    expect(
      server.gameEngine.getActiveCollabTags().some((tag) => tag.asteroidId === target.id)
    ).toBe(true);
    expect(client.failures).toEqual([]);
  });

  test('one owner finishes a tagged large roid after the dedupe window without splitting', async () => {
    const { server, clients } = await startWorld([{ id: 'solo-player', position: { x: 0, y: 0 } }]);
    const [client] = clients;
    assert.ok(client, 'solo socket');
    const target = largeIceAsteroid('wire-solo-target', { x: 100, y: 0 });
    server.gameEngine.addAsteroid(target);
    client.resetMessages();

    const now = Date.now();
    const clock = vi.spyOn(server.gameEngine, 'getServerTime').mockReturnValue(now);
    try {
      const firstStart = client.mark();
      await sendCurrentShot(server, client, 'solo-player', target.id);
      const tag = messageAt(client, 'asteroidTagged', firstStart);
      expect(tag.data).toEqual({
        asteroidId: target.id,
        shooterId: 'solo-player',
        expiresAt: now + ROID.COLLAB_SPLIT_WINDOW_MS,
      });
      expect(server.gameEngine.getAsteroid(target.id)).toBeDefined();
      client.resetMessages();
      clock.mockReturnValue(now + ROID.COLLAB_HIT_DEDUPE_MS + 1);

      const secondStart = client.mark();
      await sendCurrentShot(server, client, 'solo-player', target.id);
      const destroy = messageAt(client, 'asteroidDestroy', secondStart);
      const score = messageAt(client, 'scoreUpdate', secondStart);
      expect(destroy.data).toEqual({
        asteroidId: target.id,
        collabSplit: false,
        origin: target.position,
      });
      expect(score.data).toEqual({ playerId: 'solo-player', score: ROID.POINTS_LARGE });
      expect(countType(client, 'shockwave')).toBe(0);
      expect(countType(client, 'asteroidCreateBatch')).toBe(0);
      expect(countType(client, 'asteroidDestroy')).toBe(1);
      expect(countType(client, 'scoreUpdate')).toBe(1);
      expect(server.gameEngine.getAsteroid(target.id)).toBeUndefined();
      expect(server.gameEngine.getPlayer('solo-player')?.score).toBe(ROID.POINTS_LARGE);
      expect(client.failures).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
});
