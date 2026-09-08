/* @vitest-environment node */
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createServerInstance } from '../../../server/createServer';
import { GameEngine } from '../../../server/core/GameEngine';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { ROID } from '../../../src/constants';
import type { AsteroidData } from '../../../shared-types';

function mockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => undefined,
  } as unknown as WebSocket;
}

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

function metalAsteroid(id: string, position = { x: 0, y: 0 }): AsteroidData {
  return asteroidAt(id, 50, position, {
    material: 'metal',
    health: 75,
    maxHealth: 75,
  });
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
    isolateAsteroid(engine, asteroidAt('chip-rock', 50, { x: 100, y: 100 }, { isCollabTarget: true }));

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

describe('Client asteroid reports consume one tracked projectile', () => {
  function setup(): {
    engine: GameEngine;
    core: WebSocketCore;
    ownerWs: WebSocket;
    otherWs: WebSocket;
    asteroid: AsteroidData;
  } {
    const engine = new GameEngine(901);
    const core = new WebSocketCore(engine);
    const ownerWs = mockWs();
    const otherWs = mockWs();
    engine.addPlayer('pilot', 'Pilot', ownerWs, { x: 0, y: 0 });
    engine.addPlayer('other', 'Other', otherWs, { x: 0, y: 0 });
    const asteroid = metalAsteroid('metal-report');
    isolateAsteroid(engine, asteroid);
    return { engine, core, ownerWs, otherWs, asteroid };
  }

  function sendReport(
    core: WebSocketCore,
    ws: WebSocket,
    asteroid: AsteroidData,
    playerId = 'pilot',
    laserPosition = asteroid.position
  ): void {
    core.handleClientMessage(
      {
        type: 'asteroidDestroyed',
        data: {
          asteroidId: asteroid.id,
          playerId,
          cause: 'laser',
          laserPosition,
        },
      },
      ws
    );
  }

  function spawnAtTarget(engine: GameEngine, asteroid: AsteroidData) {
    const shot = engine.spawnHumanLaser( 'pilot', asteroid.position, { x: 0, y: 0 });
    expect(shot).toBeDefined();
    return shot!;
  }

  test('applies exactly one canonical hit regardless of client/server arrival order', () => {
    const { engine, core, ownerWs, asteroid } = setup();

    expect(engine.getAsteroid(asteroid.id)?.health).toBe(75);

    // Client report first consumes this shot; the later server tick only
    // removes the consumed projectile and cannot apply a second hit.
    const clientFirst = spawnAtTarget(engine, asteroid);
    sendReport(core, ownerWs, asteroid);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(50);
    expect(clientFirst.hasExploded).toBe(true);
    expect(engine.advanceLasersAndResolveHits()).toHaveLength(0);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(50);

    // Server tick first consumes its own exact projectile; the late client
    // report is an idempotent hint and cannot apply another hit.
    const serverShot = spawnAtTarget(engine, asteroid);
    const serverFirst = engine.resolveSpawnedLaserHits(serverShot.id);
    expect(serverFirst).toHaveLength(1);
    expect(serverFirst[0]?.outcome).toBe('tagged');
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(25);
    sendReport(core, ownerWs, asteroid);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(25);

    // The third real shot finishes the metal rock once, awarding one score
    // and one shard; replaying its client report is harmless.
    spawnAtTarget(engine, asteroid);
    sendReport(core, ownerWs, asteroid);
    expect(engine.getAsteroid(asteroid.id)).toBeUndefined();
    expect(engine.getPlayer('pilot')?.score).toBe(ROID.POINTS_LARGE);
    expect(engine.getLoot().filter((drop) => drop.kind === 'shard')).toHaveLength(1);
    sendReport(core, ownerWs, asteroid);
    expect(engine.getPlayer('pilot')?.score).toBe(ROID.POINTS_LARGE);
    expect(engine.getLoot().filter((drop) => drop.kind === 'shard')).toHaveLength(1);
  });

  test('rejects forged coordinates and cross-socket ownership without spending the shot', () => {
    const { engine, core, ownerWs, otherWs, asteroid } = setup();
    const shot = spawnAtTarget(engine, asteroid);

    sendReport(core, otherWs, asteroid, 'pilot');
    sendReport(core, ownerWs, asteroid, 'pilot', { x: 10_000, y: 10_000 });
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(75);
    expect(shot.hasExploded).toBe(false);

    sendReport(core, ownerWs, asteroid);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(50);
    expect(shot.hasExploded).toBe(true);
  });

  test('does not lose a second coincident shot to client-boundary consumption', () => {
    const { engine, core, ownerWs, asteroid } = setup();
    spawnAtTarget(engine, asteroid);
    spawnAtTarget(engine, asteroid);

    sendReport(core, ownerWs, asteroid);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(50);

    const secondShotHit = engine.advanceLasersAndResolveHits();
    expect(secondShotHit).toHaveLength(1);
    expect(secondShotHit[0]?.outcome).toBe('tagged');
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(25);
    expect(engine.getServerLasers()).toHaveLength(0);
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

    const received: Array<{ type?: string; data?: { playerId?: string; score?: number; asteroidId?: string } }> = [];
    const collect = (raw: Buffer) => received.push(JSON.parse(String(raw)));
    wsA.on('message', collect);
    wsB.on('message', collect);
    const joined = (ws: WebSocket) => new Promise<void>((resolve) => {
      const listener = (raw: Buffer) => {
        if (JSON.parse(String(raw)).type === 'joined') {
          ws.off('message', listener);
          resolve();
        }
      };
      ws.on('message', listener);
    });
    const bothJoined = Promise.all([joined(wsA), joined(wsB)]);
    wsA.send(JSON.stringify({ type: 'join', id: 'player-a', name: 'Nova' }));
    wsB.send(JSON.stringify({ type: 'join', id: 'player-b', name: 'Retro' }));
    await bothJoined;
    // Freeze simulation so only the real incoming TCP report can apply this hit.
    server.gameEngine.stopGameLoop();
    const medium = mediumAsteroid('shared-medium', { x: 200, y: 200 });
    server.gameEngine.addAsteroid(medium);

    const payload = {
      type: 'asteroidDestroyed',
      asteroidId: medium.id,
      playerId: 'player-a',
      points: ROID.POINTS_MEDIUM,
      laserPosition: { x: 200, y: 200 },
    };
    // A client report is accepted only with the corresponding tracked shot.
    // Both reports travel through their owning physical sockets.
    const trackedShot = server.gameEngine.spawnLaser('player-a', medium.position, { x: 0, y: 0 });
    expect(trackedShot).toBeDefined();
    wsA.send(JSON.stringify(payload));
    wsB.send(JSON.stringify({ ...payload, playerId: 'player-b' }));
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('TCP asteroid reports were not broadcast')); }, 2000);
      const poll = setInterval(() => {
        if (received.filter(message => message.type === 'asteroidDestroy' && message.data?.asteroidId === medium.id).length === 2) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
    expect(trackedShot?.hasExploded).toBe(true);
    expect(server.gameEngine.getAsteroid(medium.id)).toBeUndefined();

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
