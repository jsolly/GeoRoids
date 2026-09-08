import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';

function openGameSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw));
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
      expect(secondBatch.data?.asteroids?.length).toBe(firstBatch.data.asteroids.length);
      expect(secondBatch.data?.asteroids?.[0]?.id).toBe(firstBatch.data.asteroids[0].id);
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
      const initial = (firstBatch.data?.asteroids ?? []) as Array<{
        id: string;
        position: { x: number; y: number };
        velocity: { x: number; y: number };
      }>;
      expect(initial.length).toBeGreaterThan(0);

      const tracked = initial[0]!;
      server.gameEngine.updateAsteroid(tracked.id, {
        position: { x: 0, y: 0 },
        velocity: { x: 2, y: 0 },
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const liveBeforeJoin = server.gameEngine.getAsteroid(tracked.id);
      expect(liveBeforeJoin).toBeDefined();
      expect(liveBeforeJoin!.position.x).toBeGreaterThan(2);

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
      const lateField = (lateBatch.data?.asteroids ?? []) as Array<{
        id: string;
        position: { x: number; y: number };
        velocity: { x: number; y: number };
      }>;

      const lateTracked = lateField.find((asteroid) => asteroid.id === tracked.id);
      const liveAfterJoin = server.gameEngine.getAsteroid(tracked.id);
      expect(lateTracked).toBeDefined();
      expect(liveAfterJoin).toBeDefined();
      expect(lateTracked!.velocity).toEqual(liveAfterJoin!.velocity);
      expect(Math.abs(lateTracked!.position.x - liveAfterJoin!.position.x)).toBeLessThan(12);
      expect(Math.abs(lateTracked!.position.y - liveAfterJoin!.position.y)).toBeLessThan(12);
      expect(
        lateTracked!.position.x !== tracked.position.x ||
          lateTracked!.position.y !== tracked.position.y
      ).toBe(true);
      expect(Math.hypot(lateTracked!.position.x, lateTracked!.position.y)).toBeLessThan(1300);
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
