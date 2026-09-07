/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { ROID } from '../../../src/constants';
import type { AsteroidData } from '../../../shared-types';

async function openSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

function waitForAsteroidId(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for asteroid creation')), 5000);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const rows: AsteroidData[] = msg?.type === 'asteroidCreateBatch'
          ? (msg.data?.asteroids ?? [])
          : msg?.type === 'asteroidCreate' && msg.data?.asteroid ? [msg.data.asteroid] : [];
        const asteroid = rows.find((rock) => !rock.isCollabTarget && rock.material === 'ice' && rock.size >= ROID.COLLAB_SPLIT_MIN_SIZE);
        if (asteroid) {
          clearTimeout(timeout);
          resolve(asteroid.id);
        }
      } catch {
        // ignore non-JSON frames
      }
    });
  });
}

function asteroidPosition(
  server: ReturnType<typeof createServerInstance>,
  asteroidId: string
): { x: number; y: number } {
  const asteroid = server.gameEngine.getAsteroid(asteroidId);
  if (!asteroid) {
    throw new Error(`Asteroid ${asteroidId} is no longer on the server`);
  }
  return { ...asteroid.position };
}

function sendTrackedAsteroidReport(
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

describe('Scenario: two players hit a big roid within 1s → split', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    server = null;
  });

  test('two players hit big roid within 1s → split', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const playerA = await openSocket(port);
    const playerB = await openSocket(port);

    playerA.send(JSON.stringify({ type: 'join', id: 'player-a', name: 'Alpha' }));
    playerB.send(JSON.stringify({ type: 'join', id: 'player-b', name: 'Bravo' }));

    const asteroidCreated = waitForAsteroidId(playerA);
    playerA.send(JSON.stringify({ type: 'initAsteroids', id: 'player-a', asteroidCount: 1 }));
    const asteroidId = await asteroidCreated;
    asteroidPosition(server, asteroidId);

    const splitMessages: unknown[] = [];
    const onSplit = (raw: Buffer) => {
      try {
        splitMessages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    };
    playerA.on('message', onSplit);

    sendTrackedAsteroidReport(server, playerA, 'player-a', asteroidId);
    sendTrackedAsteroidReport(server, playerB, 'player-b', asteroidId);

    await expect
      .poll(
        () => {
          const destroy = splitMessages.find(
            (msg: any) => msg?.type === 'asteroidDestroy' && msg?.data?.asteroidId === asteroidId
          ) as { data?: { collabSplit?: boolean; origin?: { x: number; y: number } } } | undefined;
          const create = splitMessages.find(
            (msg: any) => msg?.type === 'asteroidCreateBatch' && msg?.data?.asteroids?.length === 2
          );
          return Boolean(destroy?.data?.collabSplit && destroy.data.origin && create);
        },
        { timeout: 3000, interval: 25 }
      )
      .toBe(true);

    playerA.close();
    playerB.close();
  });

  test('first laser hit tags and keeps the asteroid until a second shooter', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const playerA = await openSocket(port);
    playerA.send(JSON.stringify({ type: 'join', id: 'tag-player', name: 'Tagger' }));

    const asteroidCreated = waitForAsteroidId(playerA);
    playerA.send(JSON.stringify({ type: 'initAsteroids', id: 'tag-player', asteroidCount: 1 }));
    const asteroidId = await asteroidCreated;
    asteroidPosition(server, asteroidId);

    const messages: any[] = [];
    playerA.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });

    sendTrackedAsteroidReport(server, playerA, 'tag-player', asteroidId);

    await expect
      .poll(() => {
        const tagged = messages.find(
          (msg) => msg?.type === 'asteroidTagged' && msg?.data?.asteroidId === asteroidId
        );
        const destroy = messages.find(
          (msg) => msg?.type === 'asteroidDestroy' && msg?.data?.asteroidId === asteroidId
        );
        return Boolean(tagged && !destroy);
      }, { timeout: 3000, interval: 25 })
      .toBe(true);

    playerA.close();
  });

  test('forged second shooter on the same socket does not split', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const playerA = await openSocket(port);
    playerA.send(JSON.stringify({ type: 'join', id: 'socket-owner', name: 'Owner' }));

    const asteroidCreated = waitForAsteroidId(playerA);
    playerA.send(JSON.stringify({ type: 'initAsteroids', id: 'socket-owner', asteroidCount: 1 }));
    const asteroidId = await asteroidCreated;
    asteroidPosition(server, asteroidId);

    const messages: any[] = [];
    playerA.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });

    sendTrackedAsteroidReport(server, playerA, 'socket-owner', asteroidId);
    await new Promise((resolve) => setTimeout(resolve, ROID.COLLAB_HIT_DEDUPE_MS + 20));
    playerA.send(
      JSON.stringify({
        type: 'asteroidDestroyed',
        asteroidId,
        playerId: 'forged-partner',
        points: ROID.POINTS_LARGE,
        cause: 'laser',
        laserPosition: asteroidPosition(server, asteroidId),
      })
    );

    await expect
      .poll(() => {
        const destroy = messages.find(
          (msg) => msg?.type === 'asteroidDestroy' && msg?.data?.asteroidId === asteroidId
        );
        const splitBatch = messages.find(
          (msg) => msg?.type === 'asteroidCreateBatch' && msg?.data?.asteroids?.length === 2
        );
        return destroy && destroy.data.collabSplit === false && !splitBatch;
      }, { timeout: 3000, interval: 25 })
      .toBeTruthy();

    playerA.close();
  });

  test('one player hitting a big roid twice destroys it without splitting', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const playerA = await openSocket(port);
    playerA.send(JSON.stringify({ type: 'join', id: 'solo-player', name: 'Solo' }));

    const asteroidCreated = waitForAsteroidId(playerA);
    playerA.send(JSON.stringify({ type: 'initAsteroids', id: 'solo-player', asteroidCount: 1 }));
    const asteroidId = await asteroidCreated;
    asteroidPosition(server, asteroidId);

    const messages: any[] = [];
    playerA.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });

    sendTrackedAsteroidReport(server, playerA, 'solo-player', asteroidId);
    await new Promise((resolve) => setTimeout(resolve, ROID.COLLAB_HIT_DEDUPE_MS + 20));
    sendTrackedAsteroidReport(server, playerA, 'solo-player', asteroidId);

    await expect
      .poll(() => {
        const destroy = messages.find(
          (msg) => msg?.type === 'asteroidDestroy' && msg?.data?.asteroidId === asteroidId
        );
        const splitBatch = messages.find(
          (msg) => msg?.type === 'asteroidCreateBatch' && msg?.data?.asteroids?.length === 2
        );
        return destroy && destroy.data.collabSplit === false && !splitBatch;
      }, { timeout: 3000, interval: 25 })
      .toBeTruthy();

    playerA.close();
  });
});
