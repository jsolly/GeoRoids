import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import type { AsteroidData } from '../../../shared-types';

type ObservedAsteroid = Pick<AsteroidData, 'id' | 'position' | 'velocity'>;
type MessageEnvelope = Record<string, unknown> & { type: string; data?: unknown };
type IdentifiedData = Record<string, unknown> & { id: string };
type JoinedMessage = MessageEnvelope & { type: 'joined'; data: IdentifiedData };
type AsteroidBatchMessage = MessageEnvelope & {
  type: 'asteroidCreateBatch';
  data: Record<string, unknown> & { asteroids: ObservedAsteroid[] };
};
type PlayerLeftMessage = MessageEnvelope & { type: 'playerLeft'; data: IdentifiedData };
type OtherMessage = MessageEnvelope;
type ObservedMessage = JoinedMessage | AsteroidBatchMessage | PlayerLeftMessage | OtherMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return isRecord(value) && typeof value['type'] === 'string';
}

function isIdentifiedData(value: unknown): value is IdentifiedData {
  return isRecord(value) && typeof value['id'] === 'string';
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number';
}

function isObservedAsteroid(value: unknown): value is ObservedAsteroid {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    isPosition(value['position']) &&
    isPosition(value['velocity'])
  );
}

function isAsteroidBatchData(
  value: unknown
): value is Record<string, unknown> & { asteroids: ObservedAsteroid[] } {
  return (
    isRecord(value) &&
    Array.isArray(value['asteroids']) &&
    value['asteroids'].every(isObservedAsteroid)
  );
}

function parseObservedMessage(raw: WebSocket.RawData): ObservedMessage {
  const parsed: unknown = JSON.parse(String(raw));
  if (!isMessageEnvelope(parsed)) {
    throw new Error('Server message is missing its type');
  }

  const type = parsed['type'];
  const data = parsed['data'];
  if (type === 'joined') {
    if (isIdentifiedData(data)) {
      return { ...parsed, type: 'joined', data };
    }
    throw new Error('Joined message is missing its player ID');
  }
  if (type === 'asteroidCreateBatch') {
    if (isAsteroidBatchData(data)) {
      return { ...parsed, type: 'asteroidCreateBatch', data };
    }
    throw new Error('Malformed asteroidCreateBatch message');
  }
  if (type === 'playerLeft') {
    if (isIdentifiedData(data)) {
      return { ...parsed, type: 'playerLeft', data };
    }
    throw new Error(`Malformed ${type} message`);
  }
  return parsed;
}

function openGameSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, type: 'joined', timeoutMs?: number): Promise<JoinedMessage>;
function waitForMessage(
  ws: WebSocket,
  type: 'asteroidCreateBatch',
  timeoutMs?: number
): Promise<AsteroidBatchMessage>;
function waitForMessage(
  ws: WebSocket,
  type: 'playerLeft',
  timeoutMs?: number
): Promise<PlayerLeftMessage>;
function waitForMessage(
  ws: WebSocket,
  type: ObservedMessage['type'],
  timeoutMs = 5000
): Promise<ObservedMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData): void => {
      let message: ObservedMessage;
      try {
        message = parseObservedMessage(raw);
      } catch (error) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(error);
        return;
      }
      if (message.type === type) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    };

    ws.on('message', onMessage);
  });
}

describe('Server initAsteroids sync', () => {
  let server: Awaited<ReturnType<typeof createServerInstance>>;
  let wsUrl: string;

  beforeAll(async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('sends existing asteroid batches to the second player with the broadcast envelope', async () => {
    const playerOne = await openGameSocket(wsUrl);
    const playerTwo = await openGameSocket(wsUrl);

    try {
      playerOne.send(
        JSON.stringify({
          type: 'join',
          id: 'player-one',
          data: { name: 'PlayerOne', position: { x: 0, y: 0 } },
          timestamp: Date.now(),
        })
      );
      await waitForMessage(playerOne, 'joined');

      playerOne.send(
        JSON.stringify({
          type: 'initAsteroids',
          id: 'player-one',
          data: { asteroidCount: 10 },
          timestamp: Date.now(),
        })
      );
      const firstBatch = await waitForMessage(playerOne, 'asteroidCreateBatch');
      expect(firstBatch['timestamp']).toEqual(expect.any(Number));
      expect(firstBatch.data?.asteroids?.length).toBeGreaterThan(0);

      playerTwo.send(
        JSON.stringify({
          type: 'join',
          id: 'player-two',
          data: { name: 'PlayerTwo', position: { x: 100, y: 100 } },
          timestamp: Date.now(),
        })
      );
      await waitForMessage(playerTwo, 'joined');

      playerTwo.send(
        JSON.stringify({
          type: 'initAsteroids',
          id: 'player-two',
          data: { asteroidCount: 10 },
          timestamp: Date.now(),
        })
      );
      const secondBatch = await waitForMessage(playerTwo, 'asteroidCreateBatch');
      const firstAsteroid = firstBatch.data.asteroids[0];
      assert.exists(firstAsteroid);
      expect(secondBatch.data?.asteroids?.length).toBe(firstBatch.data.asteroids.length);
      expect(secondBatch.data.asteroids[0]?.id).toBe(firstAsteroid.id);
    } finally {
      playerOne.close();
      playerTwo.close();
    }
  });

  it('moves asteroids over time and a late joiner receives that same live field', async () => {
    const playerOne = await openGameSocket(wsUrl);
    const playerTwo = await openGameSocket(wsUrl);

    try {
      playerOne.send(
        JSON.stringify({
          type: 'join',
          id: 'motion-one',
          data: { name: 'MotionOne', position: { x: 0, y: 0 } },
          timestamp: Date.now(),
        })
      );
      const joinedOne = await waitForMessage(playerOne, 'joined');

      playerOne.send(
        JSON.stringify({
          type: 'initAsteroids',
          id: joinedOne.data?.id ?? 'motion-one',
          data: { asteroidCount: 10 },
          timestamp: Date.now(),
        })
      );
      const firstBatch = await waitForMessage(playerOne, 'asteroidCreateBatch');
      const initial = firstBatch.data.asteroids;
      expect(initial.length).toBeGreaterThan(0);

      const tracked = initial[0];
      assert.exists(tracked);
      server.gameEngine.updateAsteroid(tracked.id, {
        position: { x: 0, y: 0 },
        velocity: { x: 2, y: 0 },
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const liveBeforeJoin = server.gameEngine.getAsteroid(tracked.id);
      assert.exists(liveBeforeJoin);
      expect(liveBeforeJoin.position.x).toBeGreaterThan(2);

      playerTwo.send(
        JSON.stringify({
          type: 'join',
          id: 'motion-two',
          data: { name: 'MotionTwo', position: { x: 50, y: 50 } },
          timestamp: Date.now(),
        })
      );
      const joinedTwo = await waitForMessage(playerTwo, 'joined');

      playerTwo.send(
        JSON.stringify({
          type: 'initAsteroids',
          id: joinedTwo.data?.id ?? 'motion-two',
          data: { asteroidCount: 10 },
          timestamp: Date.now(),
        })
      );
      const lateBatch = await waitForMessage(playerTwo, 'asteroidCreateBatch');
      const lateField = lateBatch.data.asteroids;

      const lateTracked = lateField.find((asteroid) => asteroid.id === tracked.id);
      const liveAfterJoin = server.gameEngine.getAsteroid(tracked.id);
      assert.exists(lateTracked);
      assert.exists(liveAfterJoin);
      expect(lateTracked.velocity).toEqual(liveAfterJoin.velocity);
      expect(Math.abs(lateTracked.position.x - liveAfterJoin.position.x)).toBeLessThan(12);
      expect(Math.abs(lateTracked.position.y - liveAfterJoin.position.y)).toBeLessThan(12);
      expect(
        lateTracked.position.x !== tracked.position.x ||
          lateTracked.position.y !== tracked.position.y
      ).toBe(true);
      expect(Math.hypot(lateTracked.position.x, lateTracked.position.y)).toBeLessThan(1300);
    } finally {
      playerOne.close();
      playerTwo.close();
    }
  });

  it('keeps the live field and tells the remaining player when a peer disconnects', async () => {
    const playerOne = await openGameSocket(wsUrl);
    const playerTwo = await openGameSocket(wsUrl);

    try {
      playerOne.send(
        JSON.stringify({
          type: 'join',
          id: 'stay-one',
          data: { name: 'StayOne', position: { x: 0, y: 0 } },
          timestamp: Date.now(),
        })
      );
      const joinedOne = await waitForMessage(playerOne, 'joined');

      playerOne.send(
        JSON.stringify({
          type: 'initAsteroids',
          id: joinedOne.data?.id ?? 'stay-one',
          data: { asteroidCount: 10 },
          timestamp: Date.now(),
        })
      );
      const batch = await waitForMessage(playerOne, 'asteroidCreateBatch');
      const fieldIds = (batch.data?.asteroids ?? []).map((asteroid: { id: string }) => asteroid.id);
      expect(fieldIds.length).toBeGreaterThan(0);

      playerTwo.send(
        JSON.stringify({
          type: 'join',
          id: 'leave-two',
          data: { name: 'LeaveTwo', position: { x: 20, y: 20 } },
          timestamp: Date.now(),
        })
      );
      await waitForMessage(playerTwo, 'joined');

      const left = waitForMessage(playerOne, 'playerLeft', 4000);
      playerTwo.close();
      const leftMessage = await left;
      expect(leftMessage.data?.id).toBe('leave-two');

      expect(server.gameEngine.getPlayerCount()).toBe(1);
      expect(server.gameEngine.isGamePaused()).toBe(false);
      const remaining = server.gameEngine.getAllAsteroids();
      expect(remaining.map((asteroid) => asteroid.id).sort()).toEqual([...fieldIds].sort());
    } finally {
      playerOne.close();
      playerTwo.close();
    }
  });
});
