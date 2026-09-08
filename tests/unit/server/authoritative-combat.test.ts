import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE, SHIP } from '../../../src/constants';

function mockWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: () => undefined,
  } as unknown as WebSocket;
}

function testAsteroid(overrides: Partial<AsteroidData> = {}): AsteroidData {
  return {
    id: 'server-asteroid-0',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    ...overrides,
  };
}

function clearProtection(engine: GameEngine, id: string): void {
  engine.entityManager.updateEntity(id, { spawnProtectionTimer: 0 });
}

function clearAsteroidField(engine: GameEngine): void {
  for (const asteroid of engine.getAllAsteroids()) {
    engine.removeAsteroid(asteroid.id);
  }
}

describe('server-authoritative combat', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('overlapping human and asteroid apply one ram and destroy the roid', () => {
    engine.addPlayer('p1', 'Pilot', mockWs(), { x: 0, y: 0 });
    clearProtection(engine, 'p1');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid());

    const results = engine.resolveAuthoritativeCombat(1_000);
    const player = engine.getPlayer('p1');

    expect(results).toHaveLength(1);
    expect(results[0]?.attackerId).toBe('asteroid');
    expect(player?.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(engine.getAsteroid('server-asteroid-0')).toBeUndefined();
  });

  test('player and bot share the same asteroid ram path', () => {
    const bots = engine.createBots(1);
    expect(bots).not.toBeNull();
    const bot = bots![0]!;
    engine.entityManager.updateEntity(bot.id, {
      position: { x: 10, y: 0 },
      spawnProtectionTimer: 0,
    });
    engine.addAsteroid(testAsteroid({ id: 'server-asteroid-bot', position: { x: 10, y: 0 } }));

    engine.resolveAuthoritativeCombat(2_000);
    expect(engine.getBot(bot.id)?.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(engine.getAsteroid('server-asteroid-bot')).toBeUndefined();
  });

  test('two overlapping humans take the same ship-ship tick', () => {
    engine.addPlayer('nova', 'Nova', mockWs(), { x: 0, y: 0 });
    engine.addPlayer('retro', 'Retro', mockWs(), { x: 4, y: 0 });
    clearProtection(engine, 'nova');
    clearProtection(engine, 'retro');
    clearAsteroidField(engine);

    const first = engine.resolveAuthoritativeCombat(10_000);
    expect(first).toHaveLength(2);
    expect(engine.getPlayer('nova')?.health).toBe(SHIP.MAX_HEALTH - 1);
    expect(engine.getPlayer('retro')?.health).toBe(SHIP.MAX_HEALTH - 1);

    expect(engine.resolveAuthoritativeCombat(10_049)).toHaveLength(0);
    expect(engine.getPlayer('nova')?.health).toBe(SHIP.MAX_HEALTH - 1);

    const second = engine.resolveAuthoritativeCombat(10_050);
    expect(second).toHaveLength(2);
    expect(engine.getPlayer('nova')?.health).toBe(SHIP.MAX_HEALTH - 2);
    expect(engine.getPlayer('retro')?.health).toBe(SHIP.MAX_HEALTH - 2);
  });

  test('spawn protection blocks server ram for humans', () => {
    engine.addPlayer('p1', 'Pilot', mockWs(), { x: 0, y: 0 });
    engine.addAsteroid(testAsteroid());

    engine.resolveAuthoritativeCombat(3_000);
    expect(engine.getPlayer('p1')?.health).toBe(SHIP.MAX_HEALTH);
    expect(engine.getAsteroid('server-asteroid-0')).toBeDefined();
  });

  test('authoritative damage is sampled while death and respawn are always recorded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    engine.addPlayer('p1', 'Pilot', mockWs(), { x: 0, y: 0 });
    clearProtection(engine, 'p1');

    for (let hit = 0; hit < 4; hit++) {
      engine.handleShipDamage('p1', 'asteroid', DAMAGE.LASER_HIT, 'collision');
    }
    for (let frame = 0; frame < SHIP.RESPAWN_DELAY_FRAMES; frame++) {
      engine.advanceCombatFrame();
    }

    const stateEvents = info.mock.calls.filter(([category]) => category === 'STATE');
    expect(stateEvents.map(([, event]) => event)).toEqual([
      'damage_applied',
      'player_died',
      'player_respawned',
    ]);
    expect(stateEvents[1]?.[2]).toMatchObject({
      playerId: 'p1',
      attackerId: 'asteroid',
      source: 'collision',
      healthBefore: DAMAGE.LASER_HIT,
      healthAfter: 0,
      livesBefore: 3,
      livesAfter: 2,
    });
    expect(stateEvents[2]?.[2]).toMatchObject({
      playerId: 'p1',
      state: { health: SHIP.MAX_HEALTH, lives: 2, exploding: false },
    });
  });

  test('client asteroid and ship-ship reports are ignored', () => {
    const wsCore = new WebSocketCore(engine);
    const novaWs = mockWs();
    const retroWs = mockWs();
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'nova', name: 'Nova', position: { x: 80, y: 80 } } },
      novaWs
    );
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'retro', name: 'Retro', position: { x: 200, y: 200 } } },
      retroWs
    );
    clearProtection(engine, 'nova');
    clearProtection(engine, 'retro');

    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'nova', attackerId: 'asteroid', damage: 25 },
      },
      novaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'nova', attackerId: 'retro', damage: 1 },
      },
      novaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'retro', attackerId: 'asteroid', damage: 25 },
      },
      retroWs
    );

    const serverOwnedAsteroid = testAsteroid({
      id: 'server-owned-roid',
      isCollabTarget: true,
    });
    engine.addAsteroid(serverOwnedAsteroid);
    wsCore.handleClientMessage(
      {
        type: 'asteroidUpdate',
        data: {
          asteroidId: serverOwnedAsteroid.id,
          updates: { health: 0, position: { x: 999, y: 999 } },
        },
      },
      novaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'asteroidDestroy',
        data: { asteroidId: serverOwnedAsteroid.id },
      },
      novaWs
    );

    expect(engine.getPlayer('nova')?.health).toBe(SHIP.MAX_HEALTH);
    expect(engine.getPlayer('retro')?.health).toBe(SHIP.MAX_HEALTH);
    expect(engine.getAsteroid(serverOwnedAsteroid.id)).toMatchObject({
      health: serverOwnedAsteroid.health,
      position: serverOwnedAsteroid.position,
    });
  });

  test('human state mutations stay bound to their joined sockets', () => {
    const wsCore = new WebSocketCore(engine);
    const alphaWs = mockWs();
    const betaWs = mockWs();
    const unjoinedWs = mockWs();
    wsCore.handleClientMessage(
      {
        type: 'join',
        data: { id: 'alpha', name: 'Alpha', kitId: 'dart', position: { x: 0, y: 0 } },
      },
      alphaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'join',
        data: { id: 'beta', name: 'Beta', kitId: 'dart', position: { x: 100, y: 0 } },
      },
      betaWs
    );

    const alpha = engine.getPlayer('alpha');
    const beta = engine.getPlayer('beta');
    expect(alpha?.kitId).toBe('dart');
    expect(beta?.kitId).toBe('dart');

    wsCore.handleClientMessage(
      { type: 'update', id: 'beta', data: { position: { x: 999, y: 999 } } },
      alphaWs
    );
    wsCore.handleClientMessage(
      { type: 'update', id: 'alpha', data: { position: { x: 888, y: 888 } } },
      unjoinedWs
    );
    expect(engine.getPlayer('beta')?.position).toEqual({ x: 100, y: 0 });
    expect(engine.getPlayer('alpha')?.position).toEqual({ x: 0, y: 0 });

    wsCore.handleClientMessage({ type: 'shield', id: 'beta', data: { active: true } }, alphaWs);
    wsCore.handleClientMessage({ type: 'shield', id: 'alpha', data: { active: true } }, unjoinedWs);
    expect(engine.getPlayer('beta')?.shieldActive).toBe(false);
    expect(engine.getPlayer('alpha')?.shieldActive).toBe(false);

    wsCore.handleClientMessage(
      {
        type: 'useAbility',
        id: 'beta',
        data: { kitId: 'hauler', abilityId: 'harpoon' },
      },
      alphaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'useAbility',
        id: 'alpha',
        data: { kitId: 'quake', abilityId: 'shockPulse' },
      },
      unjoinedWs
    );
    expect(engine.getPlayer('beta')?.kitId).toBe('dart');
    expect(engine.getPlayer('alpha')?.kitId).toBe('dart');
  });

  test('shoot reports bind to the socket before creating a server laser', () => {
    const wsCore = new WebSocketCore(engine);
    const pilotWs = mockWs();
    const otherWs = mockWs();
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'pilot', name: 'Pilot', position: { x: 0, y: 0 } } },
      pilotWs
    );
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'other', name: 'Other', position: { x: 10, y: 0 } } },
      otherWs
    );
    clearAsteroidField(engine);

    wsCore.handleClientMessage(
      {
        type: 'shoot',
        id: 'other',
        data: { laserStart: { x: 0, y: 0 }, laserDirection: { x: 1, y: 0 } },
      },
      pilotWs
    );
    wsCore.handleClientMessage(
      {
        type: 'shoot',
        id: 'server-bot-0',
        data: { laserStart: { x: 0, y: 0 }, laserDirection: { x: 1, y: 0 } },
      },
      pilotWs
    );

    expect(engine.getServerLasers()).toHaveLength(0);

    wsCore.handleClientMessage(
      {
        type: 'shoot',
        id: 'pilot',
        data: { laserStart: { x: 0, y: 0 }, laserDirection: { x: 1, y: 0 } },
      },
      pilotWs
    );
    expect(engine.getServerLasers()).toHaveLength(1);
    expect(engine.getServerLasers()[0]?.ownerId).toBe('pilot');
  });

  test('asteroid laser reports require a finite position, laser cause, and socket owner', () => {
    const wsCore = new WebSocketCore(engine);
    const pilotWs = mockWs();
    const otherWs = mockWs();
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'pilot', name: 'Pilot', position: { x: 0, y: 0 } } },
      pilotWs
    );
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'other', name: 'Other', position: { x: 10, y: 0 } } },
      otherWs
    );
    clearAsteroidField(engine);
    const asteroid = testAsteroid({ id: 'reported-roid', size: 25, health: 25, maxHealth: 25 });
    engine.addAsteroid(asteroid);

    const report = (data: Record<string, unknown>) =>
      wsCore.handleClientMessage({ type: 'asteroidDestroyed', data }, pilotWs);

    report({ asteroidId: asteroid.id, playerId: 'pilot', cause: 'laser' });
    expect(engine.getAsteroid(asteroid.id)).toBeDefined();

    report({
      asteroidId: asteroid.id,
      playerId: 'pilot',
      cause: 'collision',
      laserPosition: { x: 0, y: 0 },
    });
    expect(engine.getAsteroid(asteroid.id)).toBeDefined();

    report({
      asteroidId: asteroid.id,
      playerId: 'other',
      cause: 'laser',
      laserPosition: { x: 0, y: 0 },
    });
    expect(engine.getAsteroid(asteroid.id)).toBeDefined();

    // The valid client report must correspond to a projectile the server
    // already tracks. The malformed, collision, and cross-socket reports
    // above intentionally did not spend one.
    const trackedShot = engine.spawnLaser('pilot', asteroid.position, { x: 0, y: 0 });
    expect(trackedShot).toBeDefined();
    report({
      asteroidId: asteroid.id,
      playerId: 'pilot',
      cause: 'laser',
      laserPosition: { x: 0, y: 0 },
    });
    expect(engine.getAsteroid(asteroid.id)).toBeUndefined();
    expect(engine.getPlayer('pilot')?.score).toBeGreaterThan(0);
  });

  test('collab asteroid reports use fixed damage and consume human and bot projectiles once', () => {
    const wsCore = new WebSocketCore(engine);
    const pilotWs = mockWs();
    const otherWs = mockWs();
    const unjoinedWs = mockWs();
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'pilot', name: 'Pilot', position: { x: 0, y: 0 } } },
      pilotWs
    );
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'other', name: 'Other', position: { x: 10, y: 0 } } },
      otherWs
    );
    clearAsteroidField(engine);
    const asteroid = testAsteroid({
      id: 'collab-report-roid',
      size: 50,
      health: 100,
      maxHealth: 100,
      isCollabTarget: true,
    });
    const normal = testAsteroid({ id: 'normal-report-roid' });
    engine.addAsteroid(asteroid);
    engine.addAsteroid(normal);

    const report = (
      playerId: string,
      damage: unknown,
      points: unknown,
      asteroidId = asteroid.id,
      ws: WebSocket = pilotWs
    ) =>
      wsCore.handleClientMessage(
        {
          type: 'asteroidDamage',
          data: { asteroidId, playerId, damage, points },
        },
        ws
      );

    wsCore.handleClientMessage(
      {
        type: 'asteroidDestroyed',
        data: {
          asteroidId: asteroid.id,
          playerId: 'pilot',
          cause: 'laser',
          laserPosition: asteroid.position,
        },
      },
      pilotWs
    );
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100);

    report('pilot', 999, 999);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100);
    const humanShot = engine.spawnLaser('pilot', asteroid.position, { x: 0, y: 0 });
    report('pilot', 999, 999, asteroid.id, otherWs);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100);
    expect(humanShot?.hasExploded).toBe(false);
    report('pilot', 999, 999);
    report('pilot', 999, 999);
    expect(humanShot?.hasExploded).toBe(true);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100 - DAMAGE.LASER_HIT);
    expect(engine.getPlayer('pilot')?.score).toBe(0);

    report('pilot', 0, 999);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100 - DAMAGE.LASER_HIT);
    report('pilot', 25, 999, normal.id);
    expect(engine.getAsteroid(normal.id)?.health).toBe(normal.health);

    const bot = engine.createBots(1)?.[0];
    expect(bot).toBeDefined();
    report(bot!.id, DAMAGE.LASER_HIT, 999);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100 - DAMAGE.LASER_HIT);

    engine.spawnLaser(bot!.id, asteroid.position, { x: 0, y: 0 });
    report(bot!.id, DAMAGE.LASER_HIT, 999);
    report(bot!.id, DAMAGE.LASER_HIT, 999, asteroid.id, otherWs);
    report(bot!.id, DAMAGE.LASER_HIT, 999, asteroid.id, unjoinedWs);
    expect(engine.getAsteroid(asteroid.id)?.health).toBe(100 - DAMAGE.LASER_HIT * 2);
    expect(engine.getServerLasers()[0]?.hasExploded).toBe(true);

    engine.getAsteroid(asteroid.id)!.health = DAMAGE.LASER_HIT;
    const lethalShot = engine.spawnLaser(bot!.id, asteroid.position, { x: 0, y: 0 });
    report(bot!.id, DAMAGE.LASER_HIT, 999);
    expect(engine.getAsteroid(asteroid.id)).toBeUndefined();
    expect(lethalShot?.hasExploded).toBe(true);
  });

  test('validated laserDamage is the only client path that chips a remote human', () => {
    const wsCore = new WebSocketCore(engine);
    const novaWs = mockWs();
    const retroWs = mockWs();
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'nova', name: 'Nova', position: { x: 0, y: 0 } } },
      novaWs
    );
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'retro', name: 'Retro', position: { x: 30, y: 0 } } },
      retroWs
    );
    clearProtection(engine, 'nova');
    clearProtection(engine, 'retro');

    wsCore.handleClientMessage(
      {
        type: 'laserDamage',
        data: { targetPlayerId: 'retro', attackerId: 'nova', damage: 1000 },
      },
      novaWs
    );
    expect(engine.getPlayer('retro')?.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);

    wsCore.handleClientMessage(
      {
        type: 'laserDamage',
        data: { targetPlayerId: 'nova', attackerId: 'nova', damage: 25 },
      },
      retroWs
    );
    expect(engine.getPlayer('nova')?.health).toBe(SHIP.MAX_HEALTH);
  });

  test('boundary collisionDamage still applies when the reporter is the target', () => {
    const wsCore = new WebSocketCore(engine);
    const novaWs = mockWs();
    wsCore.handleClientMessage(
      { type: 'join', data: { id: 'nova', name: 'Nova', position: { x: 0, y: 0 } } },
      novaWs
    );
    clearProtection(engine, 'nova');

    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'nova', attackerId: 'boundary', damage: 100 },
      },
      novaWs
    );

    expect(engine.getPlayer('nova')?.health).toBe(0);
    expect(engine.getPlayer('nova')?.lives).toBe(2);
  });
});
