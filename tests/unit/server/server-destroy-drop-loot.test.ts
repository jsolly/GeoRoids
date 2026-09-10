/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { LOOT_BLAST } from '../../../shared/lootBlast';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { WireClient, type WireMessage } from '../../support/wireClient';

type TestServer = ReturnType<typeof createServerInstance>;

type LootRow = {
  id: string;
  kind: string;
  mass: number;
  radius: number;
  position: { x: number; y: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageData(message: WireMessage): Record<string, unknown> {
  assert.ok(isRecord(message.data), `${message.type} message data must be an object`);
  return message.data;
}

function readLootRows(message: WireMessage): LootRow[] {
  assert.equal(message.type, 'gameState');
  const rawLoot = messageData(message)['loot'];
  assert.ok(Array.isArray(rawLoot), 'gameState loot must be an array');
  return rawLoot.map((rawDrop, index) => {
    assert.ok(isRecord(rawDrop), `loot row ${index} must be an object`);
    const id = rawDrop['id'];
    const kind = rawDrop['kind'];
    const mass = rawDrop['mass'];
    const radius = rawDrop['radius'];
    const position = rawDrop['position'];
    assert.ok(typeof id === 'string', `loot row ${index} must have an id`);
    assert.ok(typeof kind === 'string', `loot row ${index} must have a kind`);
    assert.ok(typeof mass === 'number', `loot row ${index} must have a mass`);
    assert.ok(typeof radius === 'number', `loot row ${index} must have a radius`);
    assert.ok(isRecord(position), `loot row ${index} must have a position`);
    const x = position['x'];
    const y = position['y'];
    assert.ok(typeof x === 'number', `loot row ${index} x must be numeric`);
    assert.ok(typeof y === 'number', `loot row ${index} y must be numeric`);
    return { id, kind, mass, radius, position: { x, y } };
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
  client.send({ type: 'join', id, name: id, position });
  await client.barrier();
  const joined = messageAt(client, 'joined', start);
  expect(messageData(joined)['id']).toBe(id);
}

let activeServer: TestServer | undefined;
const activeClients: WireClient[] = [];

async function connect(server: TestServer): Promise<WireClient> {
  const client = new WireClient(new WebSocket(`ws://127.0.0.1:${await server.listening}/ws`));
  activeClients.push(client);
  await client.open();
  return client;
}

async function startWorld(): Promise<{
  server: TestServer;
  playerA: WireClient;
  playerB: WireClient;
}> {
  const server = createServerInstance({ port: 0, nodeEnv: 'test' });
  activeServer = server;
  await server.listening;
  server.gameEngine.stopGameLoop();
  server.wsCore.stopPeriodicGameStateBroadcast();

  const playerA = await connect(server);
  await join(playerA, 'pilot-a', { x: 0, y: 0 });
  const playerB = await connect(server);
  await join(playerB, 'pilot-b', { x: 1_000, y: 1_000 });
  await Promise.all([playerA.barrier(), playerB.barrier()]);

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

  return { server, playerA, playerB };
}

function smallIceAsteroid(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 12,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 12,
    maxHealth: 12,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    material: 'ice',
  };
}

async function sendTrackedReport(
  server: TestServer,
  client: WireClient,
  playerId: string,
  asteroidId: string
): Promise<{ hasExploded: boolean }> {
  const asteroid = server.gameEngine.getAsteroid(asteroidId);
  assert.ok(asteroid, `asteroid ${asteroidId}`);
  const laserPosition = { ...asteroid.position };
  const shot = server.gameEngine.spawnLaser(playerId, laserPosition, { x: 0, y: 0 });
  assert.ok(shot, `tracked laser for ${playerId}`);
  client.send({
    type: 'asteroidDestroyed',
    data: {
      asteroidId,
      playerId,
      cause: 'laser',
      laserPosition,
    },
  });
  await client.barrier();
  return shot;
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

describe('shared destroy-drop shards over WebSocket', () => {
  test('two clients see one shard and explode removes it for both', async () => {
    const { server, playerA, playerB } = await startWorld();
    const target = smallIceAsteroid('wire-shard-target', { x: 0, y: 0 });
    const untouched = smallIceAsteroid('wire-untouched-roid', { x: -1_200, y: 0 });
    server.gameEngine.addAsteroid(target);
    server.gameEngine.addAsteroid(untouched);
    playerA.resetMessages();
    playerB.resetMessages();

    const reportStart = playerA.mark();
    const trackedShot = await sendTrackedReport(server, playerA, 'pilot-a', target.id);
    const destroy = messageAt(playerA, 'asteroidDestroy', reportStart);
    const score = messageAt(playerA, 'scoreUpdate', reportStart);
    expect(destroy.data).toEqual({
      asteroidId: target.id,
      collabSplit: false,
      origin: target.position,
    });
    expect(score.data).toEqual({ playerId: 'pilot-a', score: ROID.POINTS_SMALL });
    expect(trackedShot.hasExploded).toBe(true);
    expect(server.gameEngine.getAsteroid(target.id)).toBeUndefined();
    expect(server.gameEngine.getLoot()).toHaveLength(1);

    playerA.resetMessages();
    playerB.resetMessages();
    server.wsCore.getBroadcaster().broadcastGameState();
    await Promise.all([playerA.barrier(), playerB.barrier()]);
    const stateA = messageAt(playerA, 'gameState');
    const stateB = messageAt(playerB, 'gameState');
    const lootA = readLootRows(stateA);
    const lootB = readLootRows(stateB);
    expect(lootA).toHaveLength(1);
    expect(lootB).toEqual(lootA);
    const shard = lootA[0];
    assert.ok(shard, 'shared shard');
    expect(shard.kind).toBe('shard');
    expect(shard.mass).toBeGreaterThan(0);

    playerA.resetMessages();
    playerB.resetMessages();
    playerA.send({
      type: 'lootExplode',
      id: 'pilot-a',
      data: { lootId: shard.id, playerId: 'pilot-a' },
    });
    await Promise.all([playerA.barrier(), playerB.barrier()]);
    const explodedA = messageAt(playerA, 'lootExploded');
    const explodedB = messageAt(playerB, 'lootExploded');
    expect(messageData(explodedA)['lootId']).toBe(shard.id);
    expect(messageData(explodedB)['lootId']).toBe(shard.id);
    const explosion = {
      lootId: shard.id,
      position: shard.position,
      radius: LOOT_BLAST.RADIUS,
      shooterId: 'pilot-a',
    };
    expect(explodedA.data).toEqual(explosion);
    expect(explodedB.data).toEqual(explosion);
    expect(countType(playerA, 'lootExploded')).toBe(1);
    expect(server.gameEngine.getLoot()).toEqual([]);
    expect(server.gameEngine.getPlayer('pilot-a')?.score).toBe(ROID.POINTS_SMALL);
    expect(playerA.failures).toEqual([]);
    expect(playerB.failures).toEqual([]);
  });
});
