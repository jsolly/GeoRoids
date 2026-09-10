/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { describe, expect, test } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  ASTEROID_INTERACTIONS,
  previewChargedReflections,
} from '../../../shared/asteroidPhenomena';
import { captureSnapshot } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function arena() {
  const engine = new GameEngine(419);
  const ws = new RecordingSocket();
  const pilot = engine.addPlayer('pilot', 'Pilot', ws, { x: -500, y: 0 }, undefined, 'dart', 'ion');
  delete pilot.spawnProtectionTimer;
  engine.enableAsteroidInteractions(pilot);
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  const reflector: AsteroidData = {
    id: 'reflector',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 32,
    jaggedness: 0,
    rotation: Math.PI / 4,
    angularVelocity: 0,
    health: 75,
    maxHealth: 75,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'metal',
    phenomenon: { kind: 'reflective', clusterId: 'cluster', energy: 0, maxEnergy: 6 },
  };
  engine.addAsteroid(reflector);
  return { engine, pilot, ws, reflector };
}

function snapshot(engine: GameEngine) {
  return captureSnapshot({
    ...engine.getGameState(),
    playerProjectiles: engine.getPlayerProjectiles(),
    satelliteProjectiles: [],
    collabTags: [],
  });
}

describe('reflected shots remain authoritative across snapshots and resource collection', () => {
  test('an enhanced shot damages the nearest tied ship by stable id order', () => {
    const { engine, pilot } = arena();
    engine.removeAsteroid('reflector');
    for (const bot of engine.getAllBots()) {
      engine.removeBot(bot.id);
    }
    const beta = engine.addPlayer(
      'beta',
      'Beta',
      new RecordingSocket(),
      { x: 10, y: 0 },
      undefined,
      'dart',
      'ember'
    );
    const alpha = engine.addPlayer(
      'alpha',
      'Alpha',
      new RecordingSocket(),
      { x: 10, y: 0 },
      undefined,
      'dart',
      'ember'
    );
    const zeta = engine.addPlayer(
      'zeta',
      'Zeta',
      new RecordingSocket(),
      { x: 30, y: 0 },
      undefined,
      'dart',
      'ember'
    );
    for (const player of [alpha, beta, zeta]) {
      delete player.spawnProtectionTimer;
    }
    for (const satellite of engine.getAllSatellites()) {
      const internal = engine.getSatellite(satellite.id);
      if (internal) {
        internal.position = { x: 20_000, y: 20_000 };
      }
    }

    const alphaHealth = alpha.health;
    const betaHealth = beta.health;
    const zetaHealth = zeta.health;
    const shot = engine.spawnLaser(pilot.id, { x: -50, y: 0 }, { x: 100, y: 0 });
    assert.ok(shot, 'nearest-contact shot');
    engine.advanceLasersAndResolveHits();

    expect(alpha.health).toBe(alphaHealth - DAMAGE.LASER_HIT);
    expect(beta.health).toBe(betaHealth);
    expect(zeta.health).toBe(zetaHealth);
    expect(shot.hasExploded).toBe(true);
  });

  test('a flat face reverses one shot and fractional energy survives the actual snapshot validator', () => {
    const { engine, reflector } = arena();
    const shot = engine.spawnLaser('pilot', { x: -50, y: 0 }, { x: 40, y: 0 });
    assert.ok(shot, 'initial reflected shot');
    engine.advanceLasersAndResolveHits();
    expect(shot.velocity.x).toBeCloseTo(-40);
    expect(shot.velocity.y).toBeCloseTo(0);
    expect(shot.bounces).toBe(1);
    expect(shot.energy).toBe(1.5);
    expect(snapshot(engine).playerProjectiles?.[0]?.energy).toBe(1.5);
    const next = engine.spawnLaser('pilot', { x: -50, y: 0 }, { x: 40, y: 0 });
    assert.ok(next, 'second reflected shot');
    next.energy = 1.5;
    engine.advanceLasersAndResolveHits();
    expect(reflector.phenomenon?.kind === 'reflective' && reflector.phenomenon.energy).toBe(2.5);
    expect(() => snapshot(engine)).not.toThrow();
    next.energy = Number.NaN;
    expect(() => snapshot(engine)).toThrow();
  });

  test('another shot never replays the chord of an already resolved ricochet', () => {
    const { engine, pilot, ws, reflector } = arena();
    const shot = engine.spawnLaser(pilot.id, { x: -50, y: 0 }, { x: 40, y: 20 });
    assert.ok(shot, 'chord test shot');
    engine.advanceLasersAndResolveHits();
    expect(shot.bounces).toBe(1);
    const blocker: AsteroidData = {
      ...reflector,
      id: 'off-path-rock',
      size: 1,
      material: 'ice',
      position: {
        x: (shot.prevPosition.x + shot.position.x) / 2,
        y: (shot.prevPosition.y + shot.position.y) / 2,
      },
    };
    delete blocker.phenomenon;
    // This tiny rock is on the false start/end chord, outside both actual legs.
    engine.addAsteroid(blocker);
    const before = structuredClone(shot);
    const charge = reflector.phenomenon?.energy;
    const handler = new MessageHandler(engine, new GameStateBroadcaster(engine));
    handler.handleMessage(
      {
        type: 'shoot',
        id: pilot.id,
        data: {
          laserStart: { ...pilot.position },
          laserDirection: { x: 0, y: -5 },
        },
      },
      ws
    );
    expect(engine.getServerLasers()).toHaveLength(2);
    expect(shot).toEqual(before);
    expect(engine.getAsteroid(blocker.id)?.health).toBe(75);
    expect(reflector.phenomenon?.energy).toBe(charge);
  });

  test('charging the same rock destroys it once and collecting its core grants exactly six upgraded shots', () => {
    const { engine, pilot, reflector } = arena();
    for (let index = 0; index < 6; index++) {
      engine.spawnLaser(pilot.id, { x: -50, y: 0 }, { x: 40, y: 0 });
      engine.advanceLasersAndResolveHits();
    }
    expect(engine.getAsteroid(reflector.id)).toBeUndefined();
    const cores = engine.getLoot().filter((drop) => drop.kind === 'laserCore');
    expect(cores).toHaveLength(1);
    const score = pilot.score;
    engine.handleAsteroidHit(reflector.id, pilot.id);
    expect(pilot.score).toBe(score);
    const core = cores[0];
    assert.ok(core, 'laser core');
    pilot.position = { ...core.position };
    engine.collectLoot();
    const after = pilot.score;
    engine.collectLoot();
    expect(pilot.score).toBe(after);
    expect(pilot.laserUpgrade?.charges).toBe(6);
    expect(after).toBeGreaterThanOrEqual(score + ASTEROID_INTERACTIONS.coreScore);
    for (let index = 0; index < 6; index++) {
      expect(engine.spawnLaser(pilot.id, { x: 500, y: 500 }, { x: 1, y: 0 })?.energy).toBe(2);
    }
    expect(pilot.laserUpgrade).toBeUndefined();
    expect(engine.spawnLaser(pilot.id, { x: 500, y: 500 }, { x: 1, y: 0 })?.energy).toBe(1);
  });

  test('a charged reflected shot can hit its shooter while an ordinary direct shot cannot', () => {
    const { engine, pilot } = arena();
    pilot.position = { x: -100, y: 0 };
    const initial = pilot.health;
    const direct = engine.spawnLaser(pilot.id, pilot.position, { x: 10, y: 0 });
    assert.ok(direct, 'direct self shot');
    engine.advanceLasersAndResolveHits();
    expect(pilot.health).toBe(initial);
    direct.hasExploded = true;
    const reflected = engine.spawnLaser(pilot.id, { x: -50, y: 0 }, { x: 40, y: 0 });
    assert.ok(reflected, 'reflected self shot');
    for (let index = 0; index < 4; index++) {
      engine.advanceLasersAndResolveHits();
    }
    expect(reflected.hasExploded).toBe(true);
    expect(pilot.health).toBe(initial - 25 * 1.5);
  });

  test("a departed pilot's direct shot still protects allies but becomes dangerous after a real reflection", () => {
    const { engine, pilot, ws } = arena();
    const ally = engine.addPlayer('ally', 'Ally', ws, { x: -100, y: 0 }, undefined, 'dart', 'ion');
    const enemy = engine.addPlayer(
      'enemy',
      'Enemy',
      ws,
      { x: -100, y: 200 },
      undefined,
      'dart',
      'ember'
    );
    delete ally.spawnProtectionTimer;
    delete enemy.spawnProtectionTimer;
    const allyHealth = ally.health;
    const enemyHealth = enemy.health;
    const returning = engine.spawnLaser(pilot.id, { x: -150, y: 0 }, { x: 40, y: 0 });
    assert.ok(returning, 'returning direct shot');
    const hostile = engine.spawnLaser(pilot.id, { x: -150, y: 200 }, { x: 40, y: 0 });
    assert.ok(hostile, 'hostile direct shot');
    engine.removePlayer(pilot.id);
    engine.advanceLasersAndResolveHits();
    expect(ally.health).toBe(allyHealth);
    expect(returning.hasExploded).toBe(false);
    expect(returning.bounces).toBe(0);
    expect(enemy.health).toBe(enemyHealth - 25);
    expect(hostile.hasExploded).toBe(true);
    expect(
      snapshot(engine).playerProjectiles?.find((row) => row.id === returning.id)
    ).not.toHaveProperty('ownerFaction');
    for (let frame = 0; frame < 6; frame++) {
      engine.advanceLasersAndResolveHits();
    }
    expect(returning.bounces).toBe(1);
    expect(returning.hasExploded).toBe(true);
    expect(ally.health).toBe(allyHealth - 25 * 1.5);
    expect(ally.score).toBe(0);
  });

  test('the aim preview ends at the same energy threshold as the actual upgraded shot', () => {
    const { engine, reflector } = arena();
    if (reflector.phenomenon?.kind !== 'reflective') {
      throw new Error('fixture');
    }
    reflector.phenomenon.energy = 4;
    const normal = previewChargedReflections({ x: -50, y: 0 }, { x: 1, y: 0 }, [reflector], 200, 1);
    const upgraded = previewChargedReflections(
      { x: -50, y: 0 },
      { x: 1, y: 0 },
      [reflector],
      200,
      2
    );
    expect(normal.segments).toHaveLength(2);
    expect(upgraded.segments).toHaveLength(1);
    expect(upgraded.termination).toBe('blocked');
    const shot = engine.spawnLaser('pilot', { x: -50, y: 0 }, { x: 40, y: 0 });
    assert.ok(shot, 'threshold shot');
    shot.energy = 2;
    engine.advanceLasersAndResolveHits();
    expect(shot.hasExploded).toBe(true);
    expect(shot.bounces).toBe(0);
    expect(engine.getAsteroid(reflector.id)).toBeUndefined();
  });

  test('unused core charges expire from authoritative snapshots before the next ordinary shot', () => {
    const { engine, pilot } = arena();
    pilot.laserUpgrade = { charges: 4, expiresAt: Date.now() - 1 };
    engine.tickAbilities();
    expect(pilot.laserUpgrade).toBeUndefined();
    expect(
      snapshot(engine).entities.find((entity) => entity.id === pilot.id)?.laserUpgrade
    ).toBeUndefined();
    expect(engine.spawnLaser(pilot.id, { x: -50, y: 0 }, { x: 40, y: 0 })?.energy).toBe(1);
  });

  test('projectile identities never repeat across world reset or a new server instance', () => {
    const { engine } = arena();
    const beforeShot = engine.spawnLaser('pilot', { x: 500, y: 0 }, { x: 1, y: 0 });
    assert.ok(beforeShot, 'pre-reset shot');
    const before = beforeShot.id;
    engine.removePlayer('pilot');
    const afterShot = engine.spawnLaser('pilot', { x: 500, y: 0 }, { x: 1, y: 0 });
    assert.ok(afterShot, 'post-reset shot');
    const after = afterShot.id;
    const restartedShot = new GameEngine().spawnLaser('pilot', { x: 500, y: 0 }, { x: 1, y: 0 });
    assert.ok(restartedShot, 'restarted server shot');
    const restarted = restartedShot.id;
    expect(new Set([before, after, restarted]).size).toBe(3);
  });
});
