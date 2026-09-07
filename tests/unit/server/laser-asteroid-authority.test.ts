/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { GameEngine } from '../../../server/core/GameEngine';
import { ROID } from '../../../src/constants';
import type { AsteroidData } from '../../../shared-types';

function asteroidAt(
  id: string,
  size: number,
  position = { x: 400, y: 300 },
  extras: Partial<AsteroidData> = {}
): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: size,
    maxHealth: size,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    ...extras,
  };
}

function mediumAsteroid(id: string, position = { x: 400, y: 300 }): AsteroidData {
  return asteroidAt(id, 25, position);
}

function largeAsteroid(id: string, position = { x: 400, y: 300 }): AsteroidData {
  return asteroidAt(id, 50, position);
}

describe('Server laser↔asteroid authority', () => {
  test('breaks a medium asteroid once and ignores a second apply of the same hit', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
    engine.addAsteroid(mediumAsteroid('roid-once'));

    const first = engine.applyLaserAsteroidHit('roid-once', 'p1');
    const second = engine.applyLaserAsteroidHit('roid-once', 'p1');

    expect(first.applied).toBe(true);
    expect(first.outcome).toBe('destroyed');
    expect(first.points).toBe(ROID.POINTS_MEDIUM);
    expect(first.newAsteroids).toHaveLength(0);
    expect(second.applied).toBe(false);
    expect(second.newAsteroids).toHaveLength(0);
    expect(engine.getPlayer('p1')?.score).toBe(ROID.POINTS_MEDIUM);
    expect(engine.getAsteroid('roid-once')).toBeUndefined();
    expect(engine.getAsteroidCount()).toBe(0);
  });

  test('tags a large asteroid on the first hit and splits only for a second shooter', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addPlayer('p2', 'Two', {} as never, { x: 10, y: 0 });
    engine.addAsteroid(largeAsteroid('roid-collab'));

    const first = engine.applyLaserAsteroidHit('roid-collab', 'p1');
    const echo = engine.applyLaserAsteroidHit('roid-collab', 'p1');
    const partner = engine.applyLaserAsteroidHit('roid-collab', 'p2');

    expect(first.applied).toBe(true);
    expect(first.outcome).toBe('tagged');
    expect(first.split).toBe(false);
    expect(echo.applied).toBe(false);
    expect(echo.outcome).toBe('ignored');
    expect(partner.applied).toBe(true);
    expect(partner.outcome).toBe('destroyed');
    expect(partner.split).toBe(true);
    expect(partner.newAsteroids).toHaveLength(2);
    expect(engine.getPlayer('p1')?.score).toBe(0);
    expect(engine.getPlayer('p2')?.score).toBe(ROID.POINTS_LARGE);
    expect(engine.getAsteroid('roid-collab')).toBeUndefined();
  });

  test('rejects a phantom report whose laser is far from the server asteroid', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addAsteroid(largeAsteroid('roid-far', { x: 0, y: 0 }));

    const result = engine.applyLaserAsteroidHit('roid-far', 'p1', { x: 2000, y: 2000 });

    expect(result.applied).toBe(false);
    expect(engine.getAsteroid('roid-far')).toBeDefined();
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });

  test('server laser tick breaks an overlapping medium asteroid once', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addAsteroid(mediumAsteroid('roid-tick', { x: 100, y: 100 }));

    engine.spawnLaser('p1', { x: 70, y: 100 }, { x: 40, y: 0 });
    const hits = engine.advanceLasersAndResolveHits();

    expect(hits).toHaveLength(1);
    expect(hits[0]?.applied).toBe(true);
    expect(hits[0]?.asteroidId).toBe('roid-tick');
    expect(engine.getAsteroid('roid-tick')).toBeUndefined();

    const again = engine.advanceLasersAndResolveHits();
    expect(again).toHaveLength(0);
    expect(engine.getPlayer('p1')?.score).toBe(ROID.POINTS_MEDIUM);
  });

  test('server laser tick tags a large asteroid without finishing the collab window', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addAsteroid(largeAsteroid('roid-tag', { x: 100, y: 100 }));

    engine.spawnLaser('p1', { x: 70, y: 100 }, { x: 40, y: 0 });
    const hits = engine.advanceLasersAndResolveHits();

    expect(hits).toHaveLength(1);
    expect(hits[0]?.outcome).toBe('tagged');
    expect(engine.getAsteroid('roid-tag')).toBeDefined();
    expect(engine.getPlayer('p1')?.score).toBe(0);
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('server lasers skip the kits chip rock', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    engine.addAsteroid(asteroidAt('chip-rock', 50, { x: 100, y: 100 }, { isCollabTarget: true }));

    engine.spawnLaser('p1', { x: 70, y: 100 }, { x: 40, y: 0 });
    const hits = engine.advanceLasersAndResolveHits();

    expect(hits).toHaveLength(0);
    expect(engine.getAsteroid('chip-rock')).toBeDefined();
    expect(engine.getAsteroid('chip-rock')?.health).toBe(50);
  });

  test('bot and player share the same apply-once helper', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    const bots = engine.createBots(1);
    const bot = bots?.[0];
    expect(bot).toBeDefined();

    engine.addAsteroid(mediumAsteroid('roid-bot'));
    const botHit = engine.applyLaserAsteroidHit('roid-bot', bot!.id);
    const playerHit = engine.applyLaserAsteroidHit('roid-bot', 'p1');

    expect(botHit.applied).toBe(true);
    expect(botHit.points).toBe(ROID.POINTS_MEDIUM);
    expect(playerHit.applied).toBe(false);
    expect(engine.getBot(bot!.id)?.score).toBe(ROID.POINTS_MEDIUM);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });
});

describe('Two clients cannot double-apply the same asteroidDestroyed', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  let port = 0;

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

  test('second asteroidDestroyed for the same id does not award again or re-split', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    port = await server.listening;

    const wsA = new WebSocket(`ws://localhost:${port}/ws`);
    const wsB = new WebSocket(`ws://localhost:${port}/ws`);
    await Promise.all(
      [wsA, wsB].map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', (err) => reject(err));
          })
      )
    );

    wsA.send(JSON.stringify({ type: 'join', id: 'player-a', name: 'Nova' }));
    wsB.send(JSON.stringify({ type: 'join', id: 'player-b', name: 'Retro' }));

    const medium = mediumAsteroid('shared-medium', { x: 200, y: 200 });
    server.gameEngine.addAsteroid(medium);

    const received: unknown[] = [];
    const collect = (raw: Buffer) => {
      try {
        received.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    };
    wsA.on('message', collect);
    wsB.on('message', collect);

    const payload = {
      type: 'asteroidDestroyed',
      asteroidId: medium.id,
      playerId: 'player-a',
      points: ROID.POINTS_MEDIUM,
      laserPosition: { x: 200, y: 200 },
    };
    wsA.send(JSON.stringify(payload));
    wsB.send(JSON.stringify({ ...payload, playerId: 'player-b' }));

    await new Promise((resolve) => setTimeout(resolve, 400));

    const scoreUpdates = received.filter(
      (msg) => (msg as { type?: string }).type === 'scoreUpdate'
    ) as Array<{ data: { playerId: string; score: number } }>;
    const destroyIds = new Set(
      received
        .filter(
          (msg) =>
            (msg as { type?: string }).type === 'asteroidDestroy' &&
            (msg as { data?: { asteroidId?: string } }).data?.asteroidId === medium.id
        )
        .map((msg) => (msg as { data: { asteroidId: string } }).data.asteroidId)
    );
    const scorers = new Set(scoreUpdates.map((msg) => msg.data.playerId));

    expect(destroyIds.size).toBe(1);
    expect(scorers.size).toBe(1);
    expect(scoreUpdates[0]?.data.score).toBe(ROID.POINTS_MEDIUM);

    wsA.close();
    wsB.close();
  });

  test('server shoot overlapping a medium roid destroys it without a client asteroidDestroyed', async () => {
    server = createServerInstance({ port: 0, nodeEnv: 'test' });
    port = await server.listening;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    ws.send(JSON.stringify({ type: 'join', id: 'shooter', name: 'Shooter' }));
    const medium = mediumAsteroid('shoot-medium', { x: 180, y: 180 });
    server.gameEngine.addAsteroid(medium);

    const received: unknown[] = [];
    ws.on('message', (raw) => {
      try {
        received.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(
      JSON.stringify({
        type: 'shoot',
        id: 'shooter',
        laserStart: { x: medium.position.x, y: medium.position.y },
        laserDirection: { x: 10, y: 0 },
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    const destroyed = received.some(
      (msg) =>
        (msg as { type?: string }).type === 'asteroidDestroy' &&
        (msg as { data?: { asteroidId?: string } }).data?.asteroidId === medium.id
    );
    expect(destroyed).toBe(true);

    ws.close();
  });
});
