import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE, SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

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

function join(core: WebSocketCore, socket: RecordingSocket, data: Record<string, unknown>): void {
  core.handleClientMessage(
    { type: 'join', data: { ...data, snapshotVersion: 1, asteroidInteractions: 1 } },
    socket
  );
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
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
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

  test('an active Hauler harpoon protects its owner from the attached asteroid', () => {
    engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 0, y: 0 },
      undefined,
      'hauler'
    );
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));

    expect(engine.useAbility('hauler', 'hauler')).toBe(true);
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    expect(hauler?.harpoonTargetId).toBe('attached');
    expect(hauler?.harpoonTimer).toBeGreaterThan(0);

    const healthBefore = hauler.health;
    engine.resolveAuthoritativeCombat(1_000);

    expect(hauler.health).toBe(healthBefore);
    expect(engine.getAsteroid('attached')).toBeDefined();
  });

  test('an active Hauler harpoon does not protect its owner from another asteroid', () => {
    engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 0, y: 0 },
      undefined,
      'hauler'
    );
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 80, y: 0 } }));

    expect(engine.useAbility('hauler', 'hauler')).toBe(true);
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    expect(hauler.harpoonTargetId).toBe('attached');
    engine.addAsteroid(testAsteroid({ id: 'unrelated', position: { x: 0, y: 0 } }));
    const healthBefore = hauler.health;
    engine.resolveAuthoritativeCombat(1_000);

    expect(hauler.health).toBe(healthBefore - DAMAGE.LASER_HIT);
    expect(engine.getAsteroid('attached')).toBeDefined();
    expect(engine.getAsteroid('unrelated')).toBeUndefined();
  });

  test('an attached overlapping rock does not mask a second overlapping rock', () => {
    engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 0, y: 0 },
      undefined,
      'hauler'
    );
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'unrelated', position: { x: 0, y: 0 } }));

    expect(engine.useAbility('hauler', 'hauler')).toBe(true);
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    const healthBefore = hauler.health;
    engine.resolveAuthoritativeCombat(1_000);

    expect(hauler.health).toBe(healthBefore - DAMAGE.LASER_HIT);
    expect(engine.getAsteroid('attached')).toBeDefined();
    expect(engine.getAsteroid('unrelated')).toBeUndefined();
  });

  test('harpoon expiration restores the owner collision with its former target', () => {
    engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 0, y: 0 },
      undefined,
      'hauler'
    );
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));

    expect(engine.useAbility('hauler', 'hauler')).toBe(true);
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    hauler.harpoonTimer = 1;
    const healthBefore = hauler.health;
    engine.tickAbilities(1_000);

    expect(hauler.harpoonTimer).toBe(0);
    expect(hauler.harpoonTargetId).toBeUndefined();
    engine.resolveAuthoritativeCombat(1_000);

    expect(hauler.health).toBe(healthBefore - DAMAGE.LASER_HIT);
    expect(engine.getAsteroid('attached')).toBeUndefined();
  });

  test('an attached asteroid still damages and breaks for another overlapping pilot', () => {
    engine.addPlayer(
      'hauler',
      'Hauler',
      new RecordingSocket(),
      { x: 0, y: 0 },
      undefined,
      'hauler'
    );
    engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 39, y: 0 }, undefined, 'dart');
    clearProtection(engine, 'hauler');
    clearProtection(engine, 'pilot');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));

    expect(engine.useAbility('hauler', 'hauler')).toBe(true);
    const hauler = engine.getPlayer('hauler');
    const pilot = engine.getPlayer('pilot');
    assert.ok(hauler, 'hauler');
    assert.ok(pilot, 'pilot');
    const haulerHealth = hauler.health;
    const pilotHealth = pilot.health;

    engine.resolveAuthoritativeCombat(1_000);

    expect(hauler.health).toBe(haulerHealth);
    expect(pilot.health).toBe(pilotHealth - DAMAGE.LASER_HIT);
    expect(engine.getAsteroid('attached')).toBeUndefined();
  });

  test('player and bot share the same asteroid ram path', () => {
    const bots = engine.createBots(1);
    assert.ok(bots, 'created bot list');
    const bot = bots[0];
    assert.ok(bot, 'created bot');
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
    engine.addPlayer('nova', 'Nova', new RecordingSocket(), { x: 0, y: 0 });
    engine.addPlayer('retro', 'Retro', new RecordingSocket(), { x: 4, y: 0 });
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
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.addAsteroid(testAsteroid());

    engine.resolveAuthoritativeCombat(3_000);
    expect(engine.getPlayer('p1')?.health).toBe(SHIP.MAX_HEALTH);
    expect(engine.getAsteroid('server-asteroid-0')).toBeDefined();
  });

  test('authoritative damage is sampled while death and respawn are always recorded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
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
    const novaWs = new RecordingSocket();
    const retroWs = new RecordingSocket();
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: { x: 80, y: 80 } });
    join(wsCore, retroWs, { id: 'retro', name: 'Retro', position: { x: 200, y: 200 } });
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
    const expectedServerOwnedHealth = serverOwnedAsteroid.health;
    const expectedServerOwnedPosition = { ...serverOwnedAsteroid.position };
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
      health: expectedServerOwnedHealth,
      position: expectedServerOwnedPosition,
    });
  });

  test('human state mutations stay bound to their joined sockets', () => {
    const wsCore = new WebSocketCore(engine);
    const alphaWs = new RecordingSocket();
    const betaWs = new RecordingSocket();
    const unjoinedWs = new RecordingSocket();
    join(wsCore, alphaWs, {
      id: 'alpha',
      name: 'Alpha',
      kitId: 'dart',
      position: { x: 0, y: 0 },
    });
    join(wsCore, betaWs, {
      id: 'beta',
      name: 'Beta',
      kitId: 'dart',
      position: { x: 100, y: 0 },
    });

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
    const pilotWs = new RecordingSocket();
    const otherWs = new RecordingSocket();
    join(wsCore, pilotWs, { id: 'pilot', name: 'Pilot', position: { x: 0, y: 0 } });
    join(wsCore, otherWs, { id: 'other', name: 'Other', position: { x: 200, y: 0 } });
    clearAsteroidField(engine);
    expect(pilotWs.received('joined')[0]?.data).toMatchObject({ shotAcknowledgements: true });

    wsCore.handleClientMessage(
      {
        type: 'shoot',
        id: 'other',
        data: {
          laserStart: { x: 0, y: 0 },
          laserDirection: { x: 1, y: 0 },
          requestId: 'forged-other',
        },
      },
      pilotWs
    );
    wsCore.handleClientMessage(
      {
        type: 'shoot',
        id: 'server-bot-0',
        data: {
          laserStart: { x: 0, y: 0 },
          laserDirection: { x: 1, y: 0 },
          requestId: 'forged-bot',
        },
      },
      pilotWs
    );

    expect(engine.getServerLasers()).toHaveLength(0);
    expect(pilotWs.received('shotAcknowledged')).toHaveLength(0);

    wsCore.handleClientMessage(
      {
        type: 'shoot',
        id: 'pilot',
        data: {
          laserStart: { x: 0, y: 0 },
          laserDirection: { x: 1, y: 0 },
          requestId: 'owned-pilot',
        },
      },
      pilotWs
    );
    expect(engine.getServerLasers()).toHaveLength(1);
    expect(engine.getServerLasers()[0]?.ownerId).toBe('pilot');
    expect(pilotWs.received('shotAcknowledged').map((message) => message.data)).toEqual([
      { requestId: 'owned-pilot', projectileId: engine.getServerLasers()[0]?.id },
    ]);
  });

  test('boundary collisionDamage still applies when the reporter is the target', () => {
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: { x: 0, y: 0 } });
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
