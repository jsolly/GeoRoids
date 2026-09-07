/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { GameEngine } from '../../../server/core/GameEngine';
import { ROID, SHOCKWAVE } from '../../../src/constants';
import { framesToMs } from '../../../src/physics/shockwave';

async function openSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

function waitForOneShotLargeId(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for asteroid creation')), 5000);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'asteroidCreateBatch' && msg?.data?.asteroids?.length > 0) {
          const rocks = msg.data.asteroids as Array<{
            id: string;
            size?: number;
            isCollabTarget?: boolean;
          }>;
          const fallback = rocks[0];
          const oneShot = rocks.find(
            (rock) => !rock.isCollabTarget && (rock.size ?? 0) >= ROID.COLLAB_SPLIT_MIN_SIZE
          );
          const target = oneShot ?? fallback;
          if (!target) {
            return;
          }
          clearTimeout(timeout);
          resolve(target.id);
        } else if (msg?.type === 'asteroidCreate' && msg?.data?.asteroid?.id) {
          clearTimeout(timeout);
          resolve(msg.data.asteroid.id);
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

describe('Scenario: collab split fires a double shockwave', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  let engine: GameEngine | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    server = null;
    engine?.stopGameLoop();
    engine = undefined;
  });

  test('two players splitting a big roid broadcast a shockwave at the break', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const playerA = await openSocket(port);
    const playerB = await openSocket(port);

    playerA.send(JSON.stringify({ type: 'join', id: 'player-a', name: 'Alpha' }));
    playerB.send(JSON.stringify({ type: 'join', id: 'player-b', name: 'Bravo' }));

    const asteroidCreated = waitForOneShotLargeId(playerA);
    playerA.send(JSON.stringify({ type: 'initAsteroids', id: 'player-a', asteroidCount: 2 }));
    const asteroidId = await asteroidCreated;
    const laserPosition = asteroidPosition(server, asteroidId);

    const messages: Array<{ type?: string; data?: { asteroidId?: string; origin?: { x: number; y: number } } }> =
      [];
    playerA.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });

    playerA.send(
      JSON.stringify({
        type: 'asteroidDestroyed',
        asteroidId,
        playerId: 'player-a',
        points: ROID.POINTS_LARGE,
        cause: 'laser',
        laserPosition,
      })
    );
    playerB.send(
      JSON.stringify({
        type: 'asteroidDestroyed',
        asteroidId,
        playerId: 'player-b',
        points: ROID.POINTS_LARGE,
        cause: 'laser',
        laserPosition,
      })
    );

    await expect
      .poll(() => {
        const shock = messages.find((msg) => msg?.type === 'shockwave' && msg.data?.origin);
        return Boolean(shock?.data?.origin && shock.data.asteroidId === asteroidId);
      }, { timeout: 3000, interval: 25 })
      .toBe(true);

    playerA.close();
    playerB.close();
  });

  test('solo finish does not broadcast a shockwave', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    const port = await server.listening;

    const playerA = await openSocket(port);
    playerA.send(JSON.stringify({ type: 'join', id: 'solo-player', name: 'Solo' }));

    const asteroidCreated = waitForOneShotLargeId(playerA);
    playerA.send(JSON.stringify({ type: 'initAsteroids', id: 'solo-player', asteroidCount: 2 }));
    const asteroidId = await asteroidCreated;
    const laserPosition = asteroidPosition(server, asteroidId);

    const messages: Array<{ type?: string }> = [];
    playerA.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });

    const hit = {
      type: 'asteroidDestroyed',
      asteroidId,
      playerId: 'solo-player',
      points: ROID.POINTS_LARGE,
      cause: 'laser',
      laserPosition,
    };
    playerA.send(JSON.stringify(hit));
    playerA.send(JSON.stringify(hit));

    await expect
      .poll(() => messages.some((msg) => msg?.type === 'asteroidDestroy'), {
        timeout: 3000,
        interval: 25,
      })
      .toBe(true);

    expect(messages.some((msg) => msg?.type === 'shockwave')).toBe(false);

    playerA.close();
  });

  test('queued waves shove a nearby crumb harder than a nearby giant', () => {
    engine = new GameEngine(1);
    engine.createAsteroids(3);
    const [crumb, giant] = engine.getAllAsteroids();
    expect(crumb).toBeDefined();
    expect(giant).toBeDefined();

    engine.updateAsteroid(crumb!.id, {
      position: { x: 24, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 12,
    });
    engine.updateAsteroid(giant!.id, {
      position: { x: 24, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 50,
    });

    engine.queueCollabShockwave({ x: 0, y: 0 }, 0);

    const afterFastCrumb = engine.getAsteroid(crumb!.id);
    const afterFastGiant = engine.getAsteroid(giant!.id);
    expect(afterFastCrumb).toBeDefined();
    expect(afterFastGiant).toBeDefined();
    const fastCrumbKick = Math.hypot(afterFastCrumb!.velocity.x, afterFastCrumb!.velocity.y);
    const fastGiantKick = Math.hypot(afterFastGiant!.velocity.x, afterFastGiant!.velocity.y);
    expect(fastCrumbKick).toBeGreaterThan(fastGiantKick);
    expect(engine.getPendingShockwaveCount()).toBe(1);

    engine.flushDueShockwaves(framesToMs(SHOCKWAVE.HEAVY.delayFrames));
    const afterHeavyCrumb = engine.getAsteroid(crumb!.id);
    const afterHeavyGiant = engine.getAsteroid(giant!.id);
    expect(Math.hypot(afterHeavyCrumb!.velocity.x, afterHeavyCrumb!.velocity.y)).toBeGreaterThan(
      fastCrumbKick
    );
    expect(Math.hypot(afterHeavyGiant!.velocity.x, afterHeavyGiant!.velocity.y)).toBeGreaterThan(
      fastGiantKick
    );
    expect(engine.getPendingShockwaveCount()).toBe(0);
  });
});
