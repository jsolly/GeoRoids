import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE, SHIP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';
import { attachTowForScenario } from '../../support/tool-flight';

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
    { type: 'join', data: { ...data, snapshotVersion: SNAPSHOT_VERSION, asteroidInteractions: 1 } },
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

  test('overlapping player and asteroid apply one ram and destroy the roid', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    clearProtection(engine, 'p1');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid());

    const results = engine.resolveAuthoritativeCombat();
    const player = engine.getPlayer('p1');

    expect(results).toHaveLength(1);
    expect(results[0]?.attackerId).toBe('asteroid');
    expect(player?.health).toBe(SHIP.MAX_HEALTH - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('server-asteroid-0')).toBeUndefined();
  });

  test('an active Hauler harpoon protects its owner from the attached asteroid', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    expect(hauler?.harpoonTargetId).toBe('attached');

    const healthBefore = hauler.health;
    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(healthBefore);
    expect(engine.getAsteroid('attached')).toBeDefined();
  });

  test('an active Hauler harpoon does not protect its owner from another asteroid', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 80, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    expect(hauler.harpoonTargetId).toBe('attached');
    engine.addAsteroid(testAsteroid({ id: 'unrelated', position: { x: 0, y: 0 } }));
    const healthBefore = hauler.health;
    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(healthBefore - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('attached')).toBeDefined();
    expect(engine.getAsteroid('unrelated')).toBeUndefined();
  });

  test('an attached overlapping rock does not mask a second overlapping rock', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 28, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'unrelated', position: { x: -28, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    expect(hauler.harpoonTargetId).toBe('attached');
    const healthBefore = hauler.health;
    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(healthBefore - DAMAGE.ASTEROID_COLLISION);
    expect(hauler.harpoonTargetId).toBe('attached');
    expect(engine.getAsteroid('attached')).toBeDefined();
    expect(engine.getAsteroid('unrelated')).toBeUndefined();
  });

  test('towed cargo that overlaps another asteroid breaks both rocks and drops the cable', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 80, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'field-rock', position: { x: 80, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    expect(hauler.harpoonTargetId).toBe('attached');
    const healthBefore = hauler.health;

    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(healthBefore);
    expect(hauler.harpoonTargetId).toBeNull();
    expect(engine.getAsteroid('attached')).toBeUndefined();
    expect(engine.getAsteroid('field-rock')).toBeUndefined();
  });

  test('towed cargo that overlaps another asteroid shields its Hauler from that rock', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'field-rock', position: { x: 0, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    assert.ok(hauler, 'hauler');
    const healthBefore = hauler.health;

    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(healthBefore);
    expect(hauler.harpoonTargetId).toBeNull();
    expect(engine.getAsteroid('attached')).toBeUndefined();
    expect(engine.getAsteroid('field-rock')).toBeUndefined();
  });

  test('towed cargo that hits another rock and another ship still damages that ship', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 39, y: 0 }, 'scout');
    clearProtection(engine, 'hauler');
    clearProtection(engine, 'pilot');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'field-rock', position: { x: 0, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    const pilot = engine.getPlayer('pilot');
    assert.ok(hauler, 'hauler');
    assert.ok(pilot, 'pilot');
    const haulerHealth = hauler.health;
    const pilotHealth = pilot.health;

    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(haulerHealth);
    expect(hauler.harpoonTargetId).toBeNull();
    expect(pilot.health).toBe(pilotHealth - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('attached')).toBeUndefined();
    expect(engine.getAsteroid('field-rock')).toBeUndefined();
  });

  test('two Haulers whose cargo overlaps break both rocks and drop both cables', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    engine.addPlayer('hauler-2', 'Hauler Two', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearProtection(engine, 'hauler-2');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'other-cargo', position: { x: 0, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    attachTowForScenario(engine, 'hauler-2', 'other-cargo');
    const hauler = engine.getPlayer('hauler');
    const partner = engine.getPlayer('hauler-2');
    assert.ok(hauler, 'hauler');
    assert.ok(partner, 'hauler-2');
    expect(hauler.harpoonTargetId).toBe('attached');
    expect(partner.harpoonTargetId).toBe('other-cargo');
    const haulerHealth = hauler.health;
    const partnerHealth = partner.health;

    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(haulerHealth);
    expect(partner.health).toBe(partnerHealth);
    expect(hauler.harpoonTargetId).toBeNull();
    expect(partner.harpoonTargetId).toBeNull();
    expect(engine.getAsteroid('attached')).toBeUndefined();
    expect(engine.getAsteroid('other-cargo')).toBeUndefined();
  });

  test('untowed overlapping asteroids do not break each other', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 400, y: 0 }, 'hauler');
    clearProtection(engine, 'hauler');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'loose-a', position: { x: 0, y: 0 } }));
    engine.addAsteroid(testAsteroid({ id: 'loose-b', position: { x: 0, y: 0 } }));

    engine.resolveAuthoritativeCombat();

    expect(engine.getAsteroid('loose-a')).toBeDefined();
    expect(engine.getAsteroid('loose-b')).toBeDefined();
  });

  test('an attached asteroid still damages and breaks for another overlapping pilot', () => {
    engine.addPlayer('hauler', 'Hauler', new RecordingSocket(), { x: 0, y: 0 }, 'hauler');
    engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 39, y: 0 }, 'scout');
    clearProtection(engine, 'hauler');
    clearProtection(engine, 'pilot');
    clearAsteroidField(engine);
    engine.addAsteroid(testAsteroid({ id: 'attached', position: { x: 0, y: 0 } }));

    attachTowForScenario(engine, 'hauler', 'attached');
    const hauler = engine.getPlayer('hauler');
    const pilot = engine.getPlayer('pilot');
    assert.ok(hauler, 'hauler');
    assert.ok(pilot, 'pilot');
    const haulerHealth = hauler.health;
    const pilotHealth = pilot.health;

    engine.resolveAuthoritativeCombat();

    expect(hauler.health).toBe(haulerHealth);
    expect(hauler.harpoonTargetId).toBeNull();
    expect(pilot.health).toBe(pilotHealth - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('attached')).toBeUndefined();
  });

  test('two players share the same asteroid ram path', () => {
    engine.addPlayer('p2', 'Partner', new RecordingSocket(), { x: 10, y: 0 });
    engine.entityManager.updateEntity('p2', {
      spawnProtectionTimer: 0,
    });
    engine.addAsteroid(testAsteroid({ id: 'server-asteroid-partner', position: { x: 10, y: 0 } }));

    engine.resolveAuthoritativeCombat();
    expect(engine.getPlayer('p2')?.health).toBe(SHIP.MAX_HEALTH - DAMAGE.ASTEROID_COLLISION);
    expect(engine.getAsteroid('server-asteroid-partner')).toBeUndefined();
  });

  test('spawn protection blocks server ram for players', () => {
    engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    engine.addAsteroid(testAsteroid());

    engine.resolveAuthoritativeCombat();
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
      engine.handleShipDamage('p1', 'asteroid', DAMAGE.LASER_HIT);
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
    });
    expect(stateEvents[2]?.[2]).toMatchObject({
      playerId: 'p1',
      state: { health: SHIP.MAX_HEALTH, exploding: false },
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
        data: { targetPlayerId: 'nova', attackerId: 'asteroid' },
      },
      novaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'nova', attackerId: 'retro' },
      },
      novaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'retro', attackerId: 'asteroid' },
      },
      retroWs
    );

    const serverOwnedAsteroid = testAsteroid({
      id: 'server-owned-roid',
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

  test('player state mutations stay bound to their joined sockets', () => {
    const wsCore = new WebSocketCore(engine);
    const alphaWs = new RecordingSocket();
    const betaWs = new RecordingSocket();
    const unjoinedWs = new RecordingSocket();
    join(wsCore, alphaWs, {
      id: 'alpha',
      name: 'Alpha',
      kitId: 'scout',
      position: { x: 0, y: 0 },
    });
    join(wsCore, betaWs, {
      id: 'beta',
      name: 'Beta',
      kitId: 'scout',
      position: { x: 100, y: 0 },
    });

    const alpha = engine.getPlayer('alpha');
    const beta = engine.getPlayer('beta');
    expect(alpha?.kitId).toBe('scout');
    expect(beta?.kitId).toBe('scout');
    const alphaPosition = alpha ? { ...alpha.position } : undefined;
    const betaPosition = beta ? { ...beta.position } : undefined;

    wsCore.handleClientMessage(
      { type: 'update', id: 'beta', data: { position: { x: 999, y: 999 } } },
      alphaWs
    );
    wsCore.handleClientMessage(
      { type: 'update', id: 'alpha', data: { position: { x: 888, y: 888 } } },
      unjoinedWs
    );
    expect(engine.getPlayer('beta')?.position).toEqual(betaPosition);
    expect(engine.getPlayer('alpha')?.position).toEqual(alphaPosition);

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
        data: { kitId: 'scout', abilityId: 'surveyScan' },
      },
      unjoinedWs
    );
    expect(engine.getPlayer('beta')?.kitId).toBe('scout');
    expect(engine.getPlayer('alpha')?.kitId).toBe('scout');
  });

  test('a Scout terrain shot is admitted only after its current legal pose reaches the server', () => {
    engine.stopGameLoop();
    engine = new GameEngine(8306717);
    const socket = new RecordingSocket();
    const oldPosition = { x: -141.02460894974666, y: -75.0664442435621 };
    const actor = engine.addPlayer('terrain-pilot', 'Terrain pilot', socket, oldPosition, 'scout');
    actor.velocity = { x: 1.0352958031951747, y: -2.0318824196562435 };
    actor.angle = 1.0995574287564278;
    actor.spawnProtectionTimer = 0;
    actor.asteroidInteractions = 1;
    const now = engine.getServerTime();
    expect(engine.playerMotion.register(actor, socket, 1, now).ok).toBe(true);
    const start = { x: -126.73821133054508, y: -103.1050782968309 };
    const velocity = { x: 2.322998686897575, y: -4.559141627179853 };
    expect(engine.spawnPlayerLaser(actor.id, start, velocity, now + 92)).toBeNull();
    expect(
      engine.playerMotion.acceptFreePose(
        socket,
        {
          epoch: 1,
          sequence: 1,
          position: { x: -135.81802132533602, y: -85.28494781306354 },
          velocity: { x: 1.0461504063801, y: -2.0531857779000684 },
          angle: actor.angle,
          thrusting: true,
          contourLock: null,
        },
        now + 92
      ).ok
    ).toBe(true);
    expect(engine.spawnPlayerLaser(actor.id, start, velocity, now + 92)).not.toBeNull();
    expect(engine.spawnPlayerLaser(actor.id, start, { x: 100, y: 0 }, now + 92)).toBeNull();
    expect(engine.spawnPlayerLaser(actor.id, { x: 1000, y: 1000 }, velocity, now + 92)).toBeNull();
  });

  test('boundary collisionDamage still applies when the reporter is the target', () => {
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: { x: 0, y: 0 } });
    clearProtection(engine, 'nova');

    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'nova', attackerId: 'boundary' },
      },
      novaWs
    );

    expect(engine.getPlayer('nova')?.health).toBe(0);
  });
});
