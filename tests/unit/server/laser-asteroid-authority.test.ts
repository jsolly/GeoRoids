/* @vitest-environment node */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { createServerInstance } from '../../../server/createServer';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';

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

function isolateAsteroid(engine: GameEngine, asteroid: AsteroidData): void {
  for (const existing of engine.getAllAsteroids()) {
    engine.removeAsteroid(existing.id);
  }
  engine.addAsteroid(asteroid);
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

  test('server laser tick breaks an overlapping medium asteroid once', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    isolateAsteroid(engine, mediumAsteroid('roid-tick', { x: 100, y: 100 }));

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
    isolateAsteroid(engine, largeAsteroid('roid-tag', { x: 100, y: 100 }));

    engine.spawnLaser('p1', { x: 40, y: 100 }, { x: 80, y: 0 });
    const hits = engine.advanceLasersAndResolveHits();

    expect(hits).toHaveLength(1);
    expect(hits[0]?.outcome).toBe('tagged');
    expect(engine.getAsteroid('roid-tag')).toBeDefined();
    expect(engine.getPlayer('p1')?.score).toBe(0);
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('bot and player share the same apply-once helper', () => {
    const engine = new GameEngine();
    engine.addPlayer('p1', 'One', {} as never, { x: 0, y: 0 });
    const bots = engine.createBots(1);
    const bot = bots?.[0];
    assert.ok(bot);

    engine.addAsteroid(mediumAsteroid('roid-bot'));
    const botHit = engine.applyLaserAsteroidHit('roid-bot', bot.id);
    const playerHit = engine.applyLaserAsteroidHit('roid-bot', 'p1');

    expect(botHit.applied).toBe(true);
    expect(botHit.points).toBe(ROID.POINTS_MEDIUM);
    expect(playerHit.applied).toBe(false);
    expect(engine.getBot(bot.id)?.score).toBe(ROID.POINTS_MEDIUM);
    expect(engine.getPlayer('p1')?.score).toBe(0);
  });
});

describe('Asteroid destruction over real sockets', () => {
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

  test.each([
    { size: 'medium', radius: 20, points: ROID.POINTS_MEDIUM, shots: 1 },
    { size: 'large', radius: 40, points: ROID.POINTS_LARGE, shots: 2 },
  ])(
    'one pilot shoots a $size ice rock and receives its removal without fragments',
    async ({ radius, points, shots }) => {
      server = createServerInstance({ port: 0, nodeEnv: 'test' });
      server.gameEngine.stopGameLoop();
      server.wsCore.stopPeriodicGameStateBroadcast();
      port = await server.listening;

      const received: { type: string; data: unknown }[] = [];
      const decoder = new SnapshotDecoder();
      const states: ReturnType<SnapshotDecoder['decode']>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?asteroidInteractions=1`);
      ws.on('message', (raw) => {
        const message: unknown = JSON.parse(String(raw));
        assert.ok(typeof message === 'object' && message !== null);
        assert.ok('type' in message && typeof message.type === 'string');
        assert.ok('data' in message);
        received.push({ type: message.type, data: message.data });
        if (message.type === 'joined') {
          decoder.reset();
        }
        if (message.type === 'snapshot') {
          states.push(decoder.decode(message.data));
        }
      });
      await once(ws, 'open', { signal: AbortSignal.timeout(2000) });
      const barrier = async () => {
        const pong = once(ws, 'pong', { signal: AbortSignal.timeout(2000) });
        ws.ping();
        await pong;
      };
      ws.send(
        JSON.stringify({
          type: 'join',
          data: {
            id: 'shooter',
            name: 'Shooter',
            position: { x: 800, y: 800 },
            snapshotVersion: 1,
            asteroidInteractions: 1,
          },
        })
      );
      await barrier();
      expect(received.filter((message) => message.type === 'joined')).toHaveLength(1);
      const pilot = server.gameEngine.getPlayer('shooter');
      assert.ok(pilot);
      for (const bot of server.gameEngine.getAllBots()) {
        server.gameEngine.removeBot(bot.id);
      }
      // Keep the stopped world's other laser targets far from the shot corridor.
      for (const { id } of server.gameEngine.getAllSatellites()) {
        const satellite = server.gameEngine.getSatellite(id);
        assert.ok(satellite);
        satellite.position = { x: -2400, y: -2400 };
      }
      expect(server.gameEngine.getLoot()).toEqual([]);
      expect(server.gameEngine.getActiveSatelliteProjectiles()).toEqual([]);
      const targetPosition = { x: 800 + radius + 30, y: 800 };
      const target = asteroidAt('solo-ice', radius, { ...targetPosition }, { material: 'ice' });
      isolateAsteroid(server.gameEngine, target);
      const untouched = asteroidAt('untouched-ice', 20, { x: 0, y: -900 }, { material: 'ice' });
      server.gameEngine.addAsteroid(untouched);
      const scoreBefore = pilot.score;
      const now = Date.now();
      const clock = vi.spyOn(server.gameEngine, 'getServerTime').mockReturnValue(now);
      received.length = 0;
      states.length = 0;
      try {
        for (let shot = 0; shot < shots; shot++) {
          clock.mockReturnValue(now + shot * (ROID.COLLAB_HIT_DEDUPE_MS + 1));
          ws.send(
            JSON.stringify({
              type: 'shoot',
              id: pilot.id,
              laserStart: { x: targetPosition.x - radius - 2, y: targetPosition.y },
              laserDirection: { x: 10, y: 0 },
            })
          );
          await barrier();
          // Advance only the actual projectile pipeline. The stopped world cannot
          // supply an NPC hit, pickup score, expiry, or replacement asteroid.
          const hits = server.gameEngine.advanceLasersAndResolveHits();
          server.wsCore.getMessageHandler().broadcastAppliedAsteroidHits(hits);
          await barrier();
          if (shot + 1 < shots) {
            expect(server.gameEngine.getAsteroid(target.id)).toBeDefined();
            expect(pilot.score).toBe(scoreBefore);
            expect(received.filter((message) => message.type === 'asteroidTagged')).toEqual([
              {
                type: 'asteroidTagged',
                data: {
                  asteroidId: target.id,
                  shooterId: pilot.id,
                  expiresAt: now + ROID.COLLAB_SPLIT_WINDOW_MS,
                },
              },
            ]);
          }
        }
        server.wsCore.getBroadcaster().broadcastGameState();
        await barrier();
        expect(server.gameEngine.getServerLasers()).toHaveLength(0);
        expect(received.filter((message) => message.type === 'asteroidDestroy')).toEqual([
          {
            type: 'asteroidDestroy',
            data: { asteroidId: target.id, collabSplit: false, origin: targetPosition },
          },
        ]);
        expect(received.filter((message) => message.type === 'asteroidCreateBatch')).toEqual([]);
        expect(received.filter((message) => message.type === 'scoreUpdate')).toEqual([
          { type: 'scoreUpdate', data: { playerId: pilot.id, score: scoreBefore + points } },
        ]);
        expect(server.gameEngine.getAllAsteroids().map((asteroid) => asteroid.id)).toEqual([
          untouched.id,
        ]);
        expect(pilot.score).toBe(scoreBefore + points);
        expect(states.at(-1)?.asteroids.map((asteroid) => asteroid.id)).toEqual([untouched.id]);
      } finally {
        clock.mockRestore();
      }
    }
  );
});
