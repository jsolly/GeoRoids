/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';

type MessageEnvelope = Record<string, unknown> & { type: string; data?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return isRecord(value) && typeof value['type'] === 'string';
}

function reportTrackedAsteroidLaser(
  server: ReturnType<typeof createServerInstance>,
  ws: WebSocket,
  playerId: string,
  asteroidId: string
): void {
  const asteroid = server.gameEngine.getAsteroid(asteroidId);
  if (!asteroid) {
    throw new Error(`Asteroid ${asteroidId} is no longer on the server`);
  }
  const laserPosition = { ...asteroid.position };
  const shot = server.gameEngine.spawnLaser(playerId, laserPosition, { x: 0, y: 0 });
  if (!shot) {
    throw new Error(`Could not seed tracked laser for ${playerId}`);
  }
  server.wsCore.handleClientMessage(
    {
      type: 'asteroidDestroyed',
      data: {
        asteroidId,
        playerId,
        points: ROID.POINTS_LARGE,
        cause: 'laser',
        laserPosition,
      },
    },
    ws
  );
}

function waitForLargeAsteroidId(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('message', messageHandler);
    };
    const messageHandler = (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw));
        const rows: AsteroidData[] =
          msg?.type === 'asteroidCreateBatch'
            ? (msg.data?.asteroids ?? [])
            : msg?.type === 'asteroidCreate' && msg.data?.asteroid
              ? [msg.data.asteroid]
              : [];
        const asteroid = rows.find(
          (rock) =>
            !rock.isCollabTarget &&
            rock.material === 'ice' &&
            rock.size >= ROID.COLLAB_SPLIT_MIN_SIZE
        );
        if (asteroid) {
          cleanup();
          resolve(asteroid.id);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for asteroid creation'));
    }, 5000);
    ws.on('message', messageHandler);
  });
}

describe('Server scoring via asteroidDestroyed', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  let port: number = 0;

  afterEach(async () => {
    try {
      if (server) {
        await server.close();
      }
    } finally {
      server = null;
      port = 0;
    }
  });

  test('awards points and broadcasts scoreUpdate', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    port = await server.listening;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    // Join as player p1
    const playerId = 'p1-test';
    ws.send(JSON.stringify({ type: 'join', id: playerId, name: 'Tester' }));

    // Request the current server field.
    ws.send(JSON.stringify({ type: 'initAsteroids', id: playerId, asteroidCount: 1 }));

    // Capture an asteroid id from either asteroidCreateBatch or asteroidCreate.
    const asteroidId = await waitForLargeAsteroidId(ws);
    // Biggest asteroids need two laser hits from the same ship to finish
    // without a collab partner. Second hit awards points.
    const points = 20; // matches ROID.POINTS_LARGE

    // Expect a scoreUpdate reflecting the awarded points
    const activeServer = server;
    const updatedScore: number = await new Promise<number>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      let secondHitTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timeout);
        if (secondHitTimer) {
          clearTimeout(secondHitTimer);
        }
        ws.off('message', messageHandler);
      };
      const messageHandler = (raw: Buffer) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg?.type === 'scoreUpdate' && msg?.data?.playerId === playerId) {
            cleanup();
            resolve(msg.data.score);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for scoreUpdate'));
      }, 5000);
      ws.on('message', messageHandler);

      try {
        reportTrackedAsteroidLaser(activeServer, ws, playerId, asteroidId);
        secondHitTimer = setTimeout(
          () => reportTrackedAsteroidLaser(activeServer, ws, playerId, asteroidId),
          120
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    expect(updatedScore).toBe(points);

    ws.close();
  });

  test('RoidKillsPlayer scenario - server-side scoring matches client expectations', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    port = await server.listening;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    // Join as player (mimicking the client test setup)
    const playerId = 'test-player-server';
    ws.send(JSON.stringify({ type: 'join', id: playerId, name: 'TestPlayer' }));

    // Request the current server field and choose an ordinary large asteroid.
    ws.send(JSON.stringify({ type: 'initAsteroids', id: playerId, asteroidCount: 1 }));

    // Wait for asteroid creation and capture the asteroid ID.
    const asteroidId = await waitForLargeAsteroidId(ws);

    // Verify we got an asteroid ID
    expect(asteroidId).toBeDefined();
    expect(typeof asteroidId).toBe('string');
    expect(asteroidId).toMatch(/^server-asteroid-/);
    // Collect all messages received after sending asteroidDestroyed
    const receivedMessages: MessageEnvelope[] = [];
    let parseError: unknown;
    const messageHandler = (raw: Buffer) => {
      try {
        const msg: unknown = JSON.parse(String(raw));
        if (!isMessageEnvelope(msg)) {
          throw new Error('Server message is missing its type');
        }
        receivedMessages.push(msg);
      } catch (error) {
        parseError ??= error;
      }
    };
    ws.on('message', messageHandler);

    // Ship-ram is server-owned. A client collision report cannot destroy or
    // score an asteroid, even when it supplies a plausible point value.
    ws.send(
      JSON.stringify({
        type: 'asteroidDestroyed',
        asteroidId,
        playerId,
        points: ROID.POINTS_LARGE,
        cause: 'collision',
        laserPosition: server.gameEngine.getAsteroid(asteroidId)?.position,
      })
    );

    // Wait for messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Remove the message handler
    ws.off('message', messageHandler);
    expect(parseError).toBeUndefined();

    // Find the scoreUpdate message
    const scoreUpdate = receivedMessages.find((msg) => {
      if (msg['type'] !== 'scoreUpdate') {
        return false;
      }
      const data = msg['data'];
      if (!isRecord(data) || typeof data['playerId'] !== 'string') {
        throw new Error('Malformed scoreUpdate message');
      }
      return data['playerId'] === playerId;
    });

    expect(scoreUpdate).toBeUndefined();

    // Find the asteroidDestroy message
    const asteroidDestruction = receivedMessages.find((msg) => {
      if (msg['type'] !== 'asteroidDestroy') {
        return false;
      }
      const data = msg['data'];
      if (!isRecord(data) || typeof data['asteroidId'] !== 'string') {
        throw new Error('Malformed asteroidDestroy message');
      }
      return data['asteroidId'] === asteroidId;
    });

    expect(asteroidDestruction).toBeUndefined();
    expect(server.gameEngine.getAsteroid(asteroidId)).toBeDefined();

    ws.close();
  });
});
