/* @vitest-environment node */

import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { GAME, LASER, ROID } from '../../../src/constants';
import { WireClient, type WireMessage } from '../../support/wireClient';

type TestServer = ReturnType<typeof createServerInstance>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageData(message: WireMessage): Record<string, unknown> {
  assert.ok(isRecord(message.data), `${message.type} message data must be an object`);
  return message.data;
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
    snapshotVersion: SNAPSHOT_VERSION,
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
    new WebSocket(
      `ws://127.0.0.1:${await server.listening}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1`
    )
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

  for (const asteroid of server.gameEngine.getAllAsteroids()) {
    server.gameEngine.removeAsteroid(asteroid.id);
  }
  server.gameEngine.parkSatellitePickups({ x: -2_400, y: -2_400 });
  expect(server.gameEngine.getLoot()).toEqual([]);

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
      laserDirection: {
        x: direction.x * (LASER.SPEED / GAME.FPS),
        y: direction.y * (LASER.SPEED / GAME.FPS),
      },
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

describe('Pilots observe first-hit asteroid destruction', () => {
  test('two pilots receive one removal and one reward from a large ice shot', async () => {
    const { server, clients } = await startWorld([
      { id: 'first', position: { x: 0, y: 0 } },
      { id: 'second', position: { x: 0, y: 20 } },
    ]);
    const [first, second] = clients;
    assert.ok(first && second);
    const target = largeIceAsteroid('wire-first-hit', { x: 100, y: 0 });
    server.gameEngine.addAsteroid(target);
    for (const client of clients) {
      client.resetMessages();
    }
    await sendCurrentShot(server, first, 'first', target.id);
    await Promise.all(clients.map((client) => client.barrier()));
    for (const client of clients) {
      expect(messageAt(client, 'asteroidDestroy').data).toEqual({
        asteroidId: target.id,
        origin: target.position,
      });
      expect(countType(client, 'asteroidDestroy')).toBe(1);
      expect(countType(client, 'asteroidCreateBatch')).toBe(0);
      expect(countType(client, 'asteroidTagged')).toBe(0);
      expect(countType(client, 'shockwave')).toBe(0);
    }
    expect(server.gameEngine.applyLaserAsteroidHit(target.id, 'second').outcome).toBe('missing');
    expect(server.gameEngine.getLoot().filter((drop) => drop.kind === 'points')).toHaveLength(1);
    expect(server.gameEngine.getLoot().find((drop) => drop.kind === 'points')?.points).toBe(
      ROID.POINTS_LARGE
    );
  });
});
