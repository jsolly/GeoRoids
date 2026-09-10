/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { LOOT_BLAST } from '../../../shared/lootBlast';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
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
  assert.equal(message.type, 'snapshot');
  const rawLoot = messageData(message)['loot'];
  assert.ok(Array.isArray(rawLoot), 'snapshot loot must be an array');
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

async function startWorld(): Promise<{
  server: TestServer;
  playerA: WireClient;
  playerB: WireClient;
  decoderA: SnapshotDecoder;
  decoderB: SnapshotDecoder;
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
  const decoderA = new SnapshotDecoder();
  const decoderB = new SnapshotDecoder();
  decodeLatestSnapshot(playerA, decoderA);
  decodeLatestSnapshot(playerB, decoderB);

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

  return { server, playerA, playerB, decoderA, decoderB };
}

function decodeLatestSnapshot(client: WireClient, decoder: SnapshotDecoder): WireMessage {
  let latest: WireMessage | undefined;
  for (const message of client.messages) {
    if (message.type === 'snapshot') {
      latest = { ...message, data: decoder.decode(message.data) };
    }
  }
  assert.ok(latest, 'expected a snapshot frame');
  return latest;
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

async function sendLootShot(
  server: TestServer,
  client: WireClient,
  playerId: string,
  target: { x: number; y: number }
): Promise<void> {
  const shooter = server.gameEngine.getPlayer(playerId);
  assert.ok(shooter, `shooter ${playerId}`);
  const delta = { x: target.x - shooter.position.x, y: target.y - shooter.position.y };
  const distance = Math.hypot(delta.x, delta.y);
  const direction =
    distance > 0 ? { x: delta.x / distance, y: delta.y / distance } : { x: 1, y: 0 };
  client.send({
    type: 'shoot',
    id: playerId,
    data: {
      laserStart: { ...shooter.position },
      laserDirection: { x: direction.x * 5, y: direction.y * 5 },
    },
  });
  await client.barrier();
  for (let frame = 0; frame < 200 && server.gameEngine.getServerLasers().length > 0; frame++) {
    server.gameEngine.advanceOneFrame();
  }
  await client.barrier();
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
    const { server, playerA, playerB, decoderA, decoderB } = await startWorld();
    const target = smallIceAsteroid('wire-shard-target', { x: 100, y: 0 });
    const untouched = smallIceAsteroid('wire-untouched-roid', { x: -1_200, y: 0 });
    server.gameEngine.addAsteroid(target);
    server.gameEngine.addAsteroid(untouched);
    playerA.resetMessages();
    playerB.resetMessages();

    const reportStart = playerA.mark();
    await sendCurrentShot(server, playerA, 'pilot-a', target.id);
    const destroy = messageAt(playerA, 'asteroidDestroy', reportStart);
    const score = messageAt(playerA, 'scoreUpdate', reportStart);
    expect(destroy.data).toEqual({
      asteroidId: target.id,
      collabSplit: false,
      origin: target.position,
    });
    expect(score.data).toEqual({ playerId: 'pilot-a', score: ROID.POINTS_SMALL });
    expect(server.gameEngine.getAsteroid(target.id)).toBeUndefined();
    expect(server.gameEngine.getLoot()).toHaveLength(1);

    playerA.resetMessages();
    playerB.resetMessages();
    server.wsCore.getBroadcaster().broadcastGameState();
    await Promise.all([playerA.barrier(), playerB.barrier()]);
    const stateA = decodeLatestSnapshot(playerA, decoderA);
    const stateB = decodeLatestSnapshot(playerB, decoderB);
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
    await sendLootShot(server, playerA, 'pilot-a', shard.position);
    server.wsCore.getBroadcaster().broadcastGameState();
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
