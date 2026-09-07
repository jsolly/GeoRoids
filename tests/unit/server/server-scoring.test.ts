/* @vitest-environment node */
import { describe, expect, test, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { ROID } from '../../../src/constants';
import type { AsteroidData } from '../../../shared-types';

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

    // Capture an asteroid id from either asteroidCreateBatch or asteroidCreate
    const asteroidId: string = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for asteroid creation')), 5000);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          const rows: AsteroidData[] = msg?.type === 'asteroidCreateBatch'
            ? (msg.data?.asteroids ?? [])
            : msg?.type === 'asteroidCreate' && msg.data?.asteroid ? [msg.data.asteroid] : [];
          const asteroid = rows.find((rock) => !rock.isCollabTarget && rock.size >= ROID.COLLAB_SPLIT_MIN_SIZE);
          if (asteroid) {
            clearTimeout(timeout);
            resolve(asteroid.id);
          }
        } catch {}
      });
    });
    const laserPosition = server.gameEngine.getAsteroid(asteroidId)?.position;
    expect(laserPosition).toBeDefined();

    // Biggest asteroids need two laser hits from the same ship to finish
    // without a collab partner. Second hit awards points.
    const points = 20; // matches ROID.POINTS_LARGE
    ws.send(JSON.stringify({
      type: 'asteroidDestroyed',
      asteroidId,
      playerId,
      points,
      cause: 'laser',
      laserPosition,
    }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    ws.send(JSON.stringify({
      type: 'asteroidDestroyed',
      asteroidId,
      playerId,
      points,
      cause: 'laser',
      laserPosition,
    }));

    // Expect a scoreUpdate reflecting the awarded points
    const updatedScore: number = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for scoreUpdate')), 5000);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg?.type === 'scoreUpdate' && msg?.data?.playerId === playerId) {
            clearTimeout(timeout);
            resolve(msg.data.score);
          }
        } catch {}
      });
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

    // Wait for asteroid creation and capture the asteroid ID
    const asteroidId: string = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for asteroid creation')), 5000);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          const rows: AsteroidData[] = msg?.type === 'asteroidCreateBatch'
            ? (msg.data?.asteroids ?? [])
            : msg?.type === 'asteroidCreate' && msg.data?.asteroid ? [msg.data.asteroid] : [];
          const asteroid = rows.find((rock) => !rock.isCollabTarget && rock.size >= ROID.COLLAB_SPLIT_MIN_SIZE);
          if (asteroid) {
            clearTimeout(timeout);
            resolve(asteroid.id);
          }
        } catch {}
      });
    });

    // Verify we got an asteroid ID
    expect(asteroidId).toBeDefined();
    expect(typeof asteroidId).toBe('string');
    expect(asteroidId).toMatch(/^server-asteroid-/);
    const laserPosition = server.gameEngine.getAsteroid(asteroidId)?.position;
    expect(laserPosition).toBeDefined();

    // Collect all messages received after sending asteroidDestroyed
    const receivedMessages: any[] = [];
    const messageHandler = (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw));
        receivedMessages.push(msg);
      } catch {}
    };
    ws.on('message', messageHandler);

    // Ship-ram is server-owned. A client collision report cannot destroy or
    // score an asteroid, even when it supplies a plausible point value.
    ws.send(JSON.stringify({
      type: 'asteroidDestroyed',
      asteroidId,
      playerId,
      points: ROID.POINTS_LARGE,
      cause: 'collision',
      laserPosition,
    }));

    // Wait for messages to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Remove the message handler
    ws.off('message', messageHandler);

    // Find the scoreUpdate message
    const scoreUpdate = receivedMessages.find(msg =>
      msg?.type === 'scoreUpdate' && msg?.data?.playerId === playerId
    );

    expect(scoreUpdate).toBeUndefined();

    // Find the asteroidDestroy message
    const asteroidDestruction = receivedMessages.find(msg =>
      msg?.type === 'asteroidDestroy' && msg?.data?.asteroidId === asteroidId
    );

    expect(asteroidDestruction).toBeUndefined();
    expect(server.gameEngine.getAsteroid(asteroidId)).toBeDefined();

    ws.close();
  });
});

