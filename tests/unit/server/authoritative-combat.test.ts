import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { logger } from '../../../setup/serverLogger';
import { checkBoundaryCollision } from '../../../shared/boundary';
import { DAMAGE, SHIP } from '../../../shared/constants/gameplay';
import { hullRadiusForKit } from '../../../shared/shipKits';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
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

  test('every client collision report is inert, including a pilot reporting its own wall hit', () => {
    engine.createAsteroids(0);
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
    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'retro', attackerId: 'boundary' },
      },
      novaWs
    );
    // The self-targeted boundary report used to be an at-will self-destruct.
    wsCore.handleClientMessage(
      {
        type: 'collisionDamage',
        data: { targetPlayerId: 'nova', attackerId: 'boundary' },
      },
      novaWs
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
        data: {},
      },
      alphaWs
    );
    wsCore.handleClientMessage(
      {
        type: 'useAbility',
        id: 'alpha',
        data: {},
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
    const now = engine.getServerTime();
    expect(engine.playerMotion.register(actor, socket, now).ok).toBe(true);
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

  test('a reported pose that overlaps the wall is read by the server and kills', () => {
    clearAsteroidField(engine);
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    const radius = hullRadiusForKit('scout');
    const rim = { x: WORLD.radius - radius, y: 0 };
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: rim });
    clearProtection(engine, 'nova');
    const now = engine.getServerTime();
    assert.ok(engine.playerMotion.placeActorForTesting('nova', rim, now));
    const parked = engine.getPlayer('nova');
    assert.ok(parked?.playerMotion);
    const outward = engine.playerMotion.legalSpeed(parked, now) * 0.9;
    const overlapping = { x: rim.x + outward, y: 0 };
    // A live client does report this: it does not predict wall death, so the
    // hull keeps flying outward and carries the overlap in its next pose.
    expect(checkBoundaryCollision(overlapping, radius)).toBe(true);

    wsCore.handleClientMessage(
      {
        type: 'update',
        id: 'nova',
        data: {
          position: overlapping,
          velocity: { x: outward, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: parked.playerMotion.epoch,
          motionSequence: parked.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    const struck = engine.getPlayer('nova');
    expect(struck?.health).toBe(0);
    expect(struck?.exploding).toBe(true);
    // The pose was refused, so the authoritative hull never left the world.
    expect(checkBoundaryCollision(struck?.position ?? overlapping, radius)).toBe(false);
    expect(novaWs.lastReceived('playerDamaged')?.data).toMatchObject({
      targetPlayerId: 'nova',
      attackerId: 'boundary',
      isDestroyed: true,
    });
  });

  test('wall contact kills a bigger hull and a damaged hull just the same', () => {
    clearAsteroidField(engine);
    const wsCore = new WebSocketCore(engine);
    const haulerWs = new RecordingSocket();
    const radius = hullRadiusForKit('hauler');
    expect(radius).toBeGreaterThan(hullRadiusForKit('scout'));
    const rim = { x: WORLD.radius - radius, y: 0 };
    join(wsCore, haulerWs, { id: 'barge', name: 'Barge', kitId: 'hauler', position: rim });
    clearProtection(engine, 'barge');
    // A Hauler carries more hull than a Scout, so a fixed damage figure would
    // leave it alive. Damage it first too: contact kills regardless of health.
    const hauler = engine.getPlayer('barge');
    assert.ok(hauler);
    expect(hauler.maxHealth).toBeGreaterThan(SHIP.MAX_HEALTH);

    const flyIntoWall = (id: string, hullRadius: number, socket: RecordingSocket): void => {
      const edge = { x: WORLD.radius - hullRadius, y: 0 };
      const at = engine.getServerTime();
      assert.ok(engine.playerMotion.placeActorForTesting(id, edge, at));
      const ready = engine.getPlayer(id);
      assert.ok(ready?.playerMotion);
      const step = engine.playerMotion.legalSpeed(ready, at) * 0.9;
      wsCore.handleClientMessage(
        {
          type: 'update',
          id,
          data: {
            position: { x: edge.x + step, y: 0 },
            velocity: { x: step, y: 0 },
            angle: 0,
            thrusting: true,
            motionEpoch: ready.playerMotion.epoch,
            motionSequence: ready.playerMotion.ack + 1,
          },
        },
        socket
      );
    };

    // Full health first: a Hauler's 140 outlives any fixed damage figure, so
    // this is what pins the damage to the hull's own remaining health.
    expect(engine.getPlayer('barge')?.health).toBe(hauler.maxHealth);
    flyIntoWall('barge', radius, haulerWs);
    expect(engine.getPlayer('barge')?.health).toBe(0);
    expect(engine.getPlayer('barge')?.exploding).toBe(true);

    // And a part-damaged hull dies the same way: contact ignores what is left.
    const scoutWs = new RecordingSocket();
    const scoutRadius = hullRadiusForKit('scout');
    join(wsCore, scoutWs, {
      id: 'nova',
      name: 'Nova',
      position: { x: WORLD.radius - scoutRadius, y: 0 },
    });
    clearProtection(engine, 'nova');
    engine.entityManager.updateEntity('nova', { health: 40 });
    expect(engine.getPlayer('nova')?.health).toBe(40);
    flyIntoWall('nova', scoutRadius, scoutWs);
    expect(engine.getPlayer('nova')?.health).toBe(0);
    expect(engine.getPlayer('nova')?.exploding).toBe(true);
  });

  test('a cargo-protected wall contact spills the hold and leaves the hull alive', () => {
    clearAsteroidField(engine);
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    const radius = hullRadiusForKit('scout');
    const rim = { x: WORLD.radius - radius, y: 0 };
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: rim });
    clearProtection(engine, 'nova');
    engine.entityManager.updateEntity('nova', { cargo: 90 });
    const now = engine.getServerTime();
    assert.ok(engine.playerMotion.placeActorForTesting('nova', rim, now));
    const parked = engine.getPlayer('nova');
    assert.ok(parked?.playerMotion);
    const outward = engine.playerMotion.legalSpeed(parked, now) * 0.9;

    wsCore.handleClientMessage(
      {
        type: 'update',
        id: 'nova',
        data: {
          position: { x: rim.x + outward, y: 0 },
          velocity: { x: outward, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: parked.playerMotion.epoch,
          motionSequence: parked.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    // The whole 90-point hold spills, which at ECONOMY.cargoPointsPerHp = 10
    // absorbs 9 HP of the 100 HP hit, so 91 reaches the hull and 9 is left.
    const shielded = engine.getPlayer('nova');
    expect(shielded?.cargo).toBe(0);
    expect(shielded?.health).toBe(9);
    expect(shielded?.exploding).toBe(false);
    expect(engine.getLoot().filter((drop) => drop.kind === 'points')).toEqual([
      expect.objectContaining({ points: 90 }),
    ]);
  });

  test('a lethal wall contact records the death without spending the rejection warning', () => {
    clearAsteroidField(engine);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    const radius = hullRadiusForKit('scout');
    const rim = { x: WORLD.radius - radius, y: 0 };
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: rim });
    clearProtection(engine, 'nova');
    const now = engine.getServerTime();
    assert.ok(engine.playerMotion.placeActorForTesting('nova', rim, now));
    const parked = engine.getPlayer('nova');
    assert.ok(parked?.playerMotion);
    const outward = engine.playerMotion.legalSpeed(parked, now) * 0.9;

    wsCore.handleClientMessage(
      {
        type: 'update',
        id: 'nova',
        data: {
          position: { x: rim.x + outward, y: 0 },
          velocity: { x: outward, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: parked.playerMotion.epoch,
          motionSequence: parked.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    expect(engine.getPlayer('nova')?.health).toBe(0);
    expect(info.mock.calls.filter(([, event]) => event === 'player_died')).toHaveLength(1);
    expect(warn.mock.calls.map(([, event]) => event)).not.toContain('motion_command_rejected');

    // Fly again after the ordinary respawn and commit a real envelope
    // violation. It still reaches the warning channel on the same socket,
    // proving the wall death neither logged nor spent the shared throttle
    // window, and that the suppression is specific rather than blanket.
    for (let frame = 0; frame < SHIP.RESPAWN_DELAY_FRAMES; frame++) {
      engine.advanceCombatFrame();
    }
    const revived = engine.getPlayer('nova');
    assert.ok(revived?.playerMotion);
    expect(revived.health).toBe(SHIP.MAX_HEALTH);

    wsCore.handleClientMessage(
      {
        type: 'update',
        id: 'nova',
        data: {
          position: { x: 20_000, y: 0 },
          velocity: { x: 1, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: revived.playerMotion.epoch,
          motionSequence: revived.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    const rejections = warn.mock.calls.filter(([, event]) => event === 'motion_command_rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.[2]).toMatchObject({ envelope: { check: 'displacement' } });
  });

  test('a damaged hull with a full hold survives the wall on remaining health, not maximum', () => {
    clearAsteroidField(engine);
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    const radius = hullRadiusForKit('scout');
    const rim = { x: WORLD.radius - radius, y: 0 };
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: rim });
    clearProtection(engine, 'nova');
    // 40 HP remaining against a 400-point hold. Contact bills remaining health,
    // so 40 HP of damage spills exactly 400 points and nothing reaches the hull.
    // Billing maximum health instead would spill the same 400 and still land 60
    // HP, destroying the hull — the two shapes are only distinguishable when a
    // damaged hull also carries cargo.
    engine.entityManager.updateEntity('nova', { health: 40, cargo: 400 });
    const now = engine.getServerTime();
    assert.ok(engine.playerMotion.placeActorForTesting('nova', rim, now));
    const parked = engine.getPlayer('nova');
    assert.ok(parked?.playerMotion);
    const outward = engine.playerMotion.legalSpeed(parked, now) * 0.9;

    wsCore.handleClientMessage(
      {
        type: 'update',
        id: 'nova',
        data: {
          position: { x: rim.x + outward, y: 0 },
          velocity: { x: outward, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: parked.playerMotion.epoch,
          motionSequence: parked.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    const shielded = engine.getPlayer('nova');
    expect(shielded?.health).toBe(40);
    expect(shielded?.exploding).toBe(false);
    expect(shielded?.cargo).toBe(0);
    // A 400-point hold spills as several drops; the hold is what must balance.
    const spilled = engine
      .getLoot()
      .filter((drop) => drop.kind === 'points')
      .reduce((total, drop) => total + (drop.points ?? 0), 0);
    expect(spilled).toBe(400);
  });

  test('a pilot in town cannot claim a wall pose, so the wall is no self-destruct', () => {
    clearAsteroidField(engine);
    const wsCore = new WebSocketCore(engine);
    const novaWs = new RecordingSocket();
    join(wsCore, novaWs, { id: 'nova', name: 'Nova', position: { x: 0, y: 0 } });
    clearProtection(engine, 'nova');
    const now = engine.getServerTime();
    assert.ok(engine.playerMotion.placeActorForTesting('nova', { x: 0, y: 0 }, now));
    const parked = engine.getPlayer('nova');
    assert.ok(parked?.playerMotion);

    // A legal velocity with a wall-side position: unreachable from town, so the
    // envelope rejects it on displacement. A rejected pose never kills, so the
    // wall cannot be reached by claiming it.
    wsCore.handleClientMessage(
      {
        type: 'update',
        id: 'nova',
        data: {
          position: { x: WORLD.radius, y: 0 },
          velocity: { x: 1, y: 0 },
          angle: 0,
          thrusting: true,
          motionEpoch: parked.playerMotion.epoch,
          motionSequence: parked.playerMotion.ack + 1,
        },
      },
      novaWs
    );

    const held = engine.getPlayer('nova');
    expect(held?.health).toBe(SHIP.MAX_HEALTH);
    expect(held?.exploding).toBe(false);
    expect(held?.position).toEqual({ x: 0, y: 0 });
    expect(novaWs.received('playerDamaged')).toHaveLength(0);
  });
});
