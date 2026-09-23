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
import { GAME, LASER } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function arena() {
  const engine = new GameEngine(419);
  const ws = new RecordingSocket();
  const pilot = engine.addPlayer('pilot', 'Pilot', ws, { x: -500, y: 0 }, 'scout');
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
    collabTags: [],
  });
}

describe('reflected shots remain authoritative across snapshots and resource collection', () => {
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
          laserDirection: { x: 0, y: -LASER.SPEED / GAME.FPS },
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
    const score = pilot.cargo;
    engine.handleAsteroidHit(reflector.id, pilot.id);
    expect(pilot.cargo).toBe(score);
    const core = cores[0];
    assert.ok(core, 'laser core');
    pilot.position = { ...core.position };
    engine.collectLoot();
    const after = pilot.cargo;
    engine.collectLoot();
    expect(pilot.cargo).toBe(after);
    expect(pilot.laserUpgrade?.charges).toBe(6);
    expect(after).toBeGreaterThanOrEqual(score + ASTEROID_INTERACTIONS.coreScore);
    for (let index = 0; index < 6; index++) {
      expect(engine.spawnLaser(pilot.id, { x: 500, y: 500 }, { x: 1, y: 0 })?.energy).toBe(2);
    }
    expect(pilot.laserUpgrade).toBeUndefined();
    expect(engine.spawnLaser(pilot.id, { x: 500, y: 500 }, { x: 1, y: 0 })?.energy).toBe(1);
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
