/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE, SATELLITE_PICKUP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function clearAsteroids(engine: GameEngine): void {
  for (const asteroid of engine.getAllAsteroids()) {
    engine.removeAsteroid(asteroid.id);
  }
}

function asteroidAt(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

describe('satellite pickups intercept physical damage', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(654321);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  function addOwner(): void {
    engine.addPlayer(
      'owner',
      'Owner',
      new RecordingSocket(),
      { x: 0, y: 0 },
      undefined,
      'surveyor',
      'ion'
    );
    engine.updatePlayer('owner', { spawnProtectionTimer: 0 });
    clearAsteroids(engine);
  }

  function attachFirstPickup(): string {
    const pickup = engine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    engine.updatePlayer('owner', {
      position: { x: pickup.position.x + 110, y: pickup.position.y },
    });
    engine.tickSatellitePickups();
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('orbiting');
    engine.updatePlayer('owner', { position: { x: 0, y: 0 } });
    engine.tickSatellitePickups();
    return pickup.id;
  }

  function addAttacker(faction: 'ion' | 'ember' = 'ember'): void {
    engine.addPlayer(
      'attacker',
      'Attacker',
      new RecordingSocket(),
      { x: 1000, y: 1000 },
      undefined,
      'surveyor',
      faction
    );
    engine.updatePlayer('attacker', { spawnProtectionTimer: 0 });
    clearAsteroids(engine);
  }

  test('a pickup intercepts a hostile shot before the owner hull and takes ordinary damage', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;

    engine.spawnLaser('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
    engine.advanceLasersAndResolveHits(1_000);

    expect(engine.getSatellitePickup(pickupId)?.health).toBe(
      SATELLITE_PICKUP.HEALTH - DAMAGE.LASER_HIT
    );
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('a shot that misses the pickup still damages the owner hull', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;

    engine.spawnLaser('attacker', { x: 0, y: -120 }, { x: 0, y: 240 });
    engine.advanceLasersAndResolveHits(1_000);

    expect(engine.getPlayer('owner')?.health).toBe((ownerHealth ?? 0) - DAMAGE.LASER_HIT);
    expect(engine.getSatellitePickup(pickupId)?.health).toBe(SATELLITE_PICKUP.HEALTH);
    expect(engine.getServerLasers()).toHaveLength(0);
  });

  test('a friendly first-pass shot follows the existing no-friendly-fire rule through the pickup', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker('ion');
    const ownerHealth = engine.getPlayer('owner')?.health;

    engine.spawnLaser('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
    engine.advanceLasersAndResolveHits(1_000);

    expect(engine.getSatellitePickup(pickupId)?.health).toBe(SATELLITE_PICKUP.HEALTH);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
    expect(engine.getServerLasers()).toHaveLength(1);
  });

  test('two ordinary shots break the intercepted pickup and the owner stays exposed afterward', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;

    for (let shot = 0; shot < 2; shot += 1) {
      engine.spawnLaser('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
      engine.advanceLasersAndResolveHits(1_000 + shot);
    }

    expect(engine.getSatellitePickup(pickupId)?.state).toBe('broken');
    expect(engine.getSatellitePickup(pickupId)?.health).toBe(0);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);

    engine.spawnLaser('attacker', { x: 0, y: -120 }, { x: 0, y: 240 });
    engine.advanceLasersAndResolveHits(1_100);
    expect(engine.getPlayer('owner')?.health).toBe((ownerHealth ?? 0) - DAMAGE.LASER_HIT);
  });

  test('an asteroid body damages a loose pickup without protecting a ship globally', () => {
    addOwner();
    const pickup = engine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    engine.addAsteroid(asteroidAt('pickup-rock', pickup.position));

    engine.resolveAuthoritativeCombat(1_000);
    expect(engine.getSatellitePickup(pickup.id)?.health).toBe(
      SATELLITE_PICKUP.HEALTH - DAMAGE.LASER_HIT
    );
    engine.resolveAuthoritativeCombat(1_001);
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('broken');
    expect(engine.getAsteroid('pickup-rock')).toBeDefined();
  });
});
