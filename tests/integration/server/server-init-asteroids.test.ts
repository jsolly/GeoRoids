import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import type { AsteroidData, Position } from '../../../shared-types';

import { WireClient, type WireMessage } from '../../support/wireClient';

type JsonRecord = Record<string, unknown>;

type FieldRock = Pick<AsteroidData, 'id' | 'position' | 'velocity'>;

type TestServer = ReturnType<typeof createServerInstance>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
  if (!isRecord(value)) {
    return false;
  }
  const x = value['x'];
  const y = value['y'];
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
}

function isFieldRock(value: unknown): value is FieldRock {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    isPosition(value['position']) &&
    isPosition(value['velocity'])
  );
}

function messageData(message: WireMessage): JsonRecord {
  if (!isRecord(message.data)) {
    throw new Error(`${message.type} message data must be an object`);
  }
  return message.data;
}

function readJoinedId(message: WireMessage): string {
  if (message.type !== 'joined') {
    throw new Error(`Expected joined message, received ${message.type}`);
  }
  const id = messageData(message)['id'];
  if (typeof id !== 'string') {
    throw new Error('Joined message is missing its player ID');
  }
  return id;
}

function readAsteroidBatch(message: WireMessage): FieldRock[] {
  if (message.type !== 'asteroidCreateBatch') {
    throw new Error(`Expected asteroidCreateBatch, received ${message.type}`);
  }
  const rawAsteroids = messageData(message)['asteroids'];
  if (!Array.isArray(rawAsteroids)) {
    throw new Error('Asteroid batch is missing its asteroid array');
  }
  const asteroids: FieldRock[] = [];
  for (const [index, rawAsteroid] of rawAsteroids.entries()) {
    if (!isFieldRock(rawAsteroid)) {
      throw new Error(`Asteroid batch row ${index} is missing its identity or motion`);
    }
    asteroids.push(rawAsteroid);
  }
  return asteroids;
}

function readPlayerLeftId(message: WireMessage): string {
  if (message.type !== 'playerLeft') {
    throw new Error(`Expected playerLeft message, received ${message.type}`);
  }
  const id = messageData(message)['id'];
  if (typeof id !== 'string') {
    throw new Error('playerLeft message is missing its player ID');
  }
  return id;
}

function messageAt(messages: readonly WireMessage[], start: number, type: string): WireMessage {
  const message = messages.slice(start).find((candidate) => candidate.type === type);
  if (!message) {
    const seen = messages
      .slice(start)
      .map((candidate) => candidate.type)
      .join(', ');
    throw new Error(`Expected ${type}; received ${seen || 'no messages'}`);
  }
  return message;
}

function snapshotAsteroid(server: TestServer, id: string): AsteroidData {
  const asteroid = server.gameEngine.getAsteroid(id);
  if (!asteroid) {
    throw new Error(`Asteroid ${id} is absent from the authoritative field`);
  }
  return structuredClone(asteroid);
}

function snapshotField(server: TestServer): AsteroidData[] {
  return structuredClone(server.gameEngine.getAllAsteroids());
}

let server: TestServer | undefined;
let wsUrl = '';
const sockets: WireClient[] = [];

function requireServer(): TestServer {
  if (!server) {
    throw new Error('Test server has not been started');
  }
  return server;
}

async function openGameSocket(): Promise<WireClient> {
  const socket = new WireClient(new WebSocket(wsUrl));
  sockets.push(socket);
  await socket.open();
  return socket;
}

async function join(socket: WireClient, id: string, position: Position): Promise<void> {
  const start = socket.mark();
  socket.send({
    type: 'join',
    id,
    data: { name: id, position },
  });
  await socket.barrier();
  const joined = messageAt(socket.messages, start, 'joined');
  expect(readJoinedId(joined)).toBe(id);
}

async function requestAsteroids(socket: WireClient, id: string): Promise<FieldRock[]> {
  const start = socket.mark();
  socket.send({
    type: 'initAsteroids',
    id,
    data: { asteroidCount: 10 },
  });
  await socket.barrier();
  return readAsteroidBatch(messageAt(socket.messages, start, 'asteroidCreateBatch'));
}

beforeEach(async () => {
  server = createServerInstance({ port: 0, nodeEnv: 'test' });
  const port = await server.listening;
  server.gameEngine.stopGameLoop();
  server.wsCore.stopPeriodicGameStateBroadcast();
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  try {
    await server?.close();
    for (const socket of sockets) {
      socket.assertHealthy();
    }
  } finally {
    server = undefined;
    wsUrl = '';
    sockets.length = 0;
  }
});

describe('Server initAsteroids sync', () => {
  it('sends the existing asteroid batch to a second player with the broadcast envelope', async () => {
    const current = requireServer();
    const playerOne = await openGameSocket();
    await join(playerOne, 'player-one', { x: 0, y: 0 });
    const firstBatch = await requestAsteroids(playerOne, 'player-one');
    expect(firstBatch.length).toBeGreaterThan(0);

    const playerTwo = await openGameSocket();
    await join(playerTwo, 'player-two', { x: 100, y: 100 });
    const secondBatch = await requestAsteroids(playerTwo, 'player-two');

    expect(secondBatch).toEqual(firstBatch);
    expect(current.gameEngine.getAllAsteroids().map((asteroid) => asteroid.id)).toEqual(
      firstBatch.map((asteroid) => asteroid.id)
    );
    playerOne.assertHealthy();
    playerTwo.assertHealthy();
  });

  it('moves the live field by explicit ticks and gives a late joiner that exact field', async () => {
    const current = requireServer();
    const playerOne = await openGameSocket();
    await join(playerOne, 'motion-one', { x: 0, y: 0 });
    const initialBatch = await requestAsteroids(playerOne, 'motion-one');
    const tracked = initialBatch[0];
    if (!tracked) {
      throw new Error('Initial asteroid batch is empty');
    }

    current.gameEngine.updateAsteroid(tracked.id, {
      position: { x: 0, y: 0 },
      velocity: { x: 2, y: 0 },
    });
    const arranged = snapshotAsteroid(current, tracked.id);
    for (let frame = 0; frame < 3; frame++) {
      current.gameEngine.advanceOneFrame();
    }
    const liveBeforeJoin = snapshotAsteroid(current, tracked.id);
    expect(liveBeforeJoin.position).toEqual({ x: 6, y: 0 });
    expect(liveBeforeJoin.velocity).toEqual({ x: 2, y: 0 });
    expect(liveBeforeJoin.position).not.toEqual(arranged.position);

    const playerTwo = await openGameSocket();
    await join(playerTwo, 'motion-two', { x: 50, y: 50 });
    const lateBatch = await requestAsteroids(playerTwo, 'motion-two');
    const liveAfterJoin = snapshotField(current);

    expect(lateBatch).toEqual(liveAfterJoin);
    const lateTracked = lateBatch.find((asteroid) => asteroid.id === tracked.id);
    if (!lateTracked) {
      throw new Error(`Late batch omitted tracked asteroid ${tracked.id}`);
    }
    expect(lateTracked).toEqual(liveAfterJoin.find((asteroid) => asteroid.id === tracked.id));
    expect(lateTracked.position).toEqual(liveBeforeJoin.position);
    expect(lateTracked.velocity).toEqual(liveBeforeJoin.velocity);
    playerOne.assertHealthy();
    playerTwo.assertHealthy();
  });

  it('keeps the live field and tells the remaining player when a peer disconnects', async () => {
    const current = requireServer();
    const playerOne = await openGameSocket();
    await join(playerOne, 'stay-one', { x: 0, y: 0 });
    const initialBatch = await requestAsteroids(playerOne, 'stay-one');
    expect(initialBatch.length).toBeGreaterThan(0);
    const fieldIds = initialBatch.map((asteroid) => asteroid.id).sort();

    const playerTwo = await openGameSocket();
    await join(playerTwo, 'leave-two', { x: 20, y: 20 });
    const leftStart = playerOne.mark();
    await playerTwo.close();
    await playerOne.barrier();

    const leftMessage = messageAt(playerOne.messages, leftStart, 'playerLeft');
    expect(readPlayerLeftId(leftMessage)).toBe('leave-two');
    expect(current.gameEngine.getPlayerCount()).toBe(1);
    expect(current.gameEngine.isGamePaused()).toBe(false);
    expect(
      current.gameEngine
        .getAllAsteroids()
        .map((asteroid) => asteroid.id)
        .sort()
    ).toEqual(fieldIds);
    playerOne.assertHealthy();
    playerTwo.assertHealthy();
  });
});
