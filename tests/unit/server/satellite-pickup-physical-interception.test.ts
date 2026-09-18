/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE } from '../../../src/constants';
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
    engine.addPlayer('owner', 'Owner', new RecordingSocket(), { x: 0, y: 0 }, 'surveyor');
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
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('stored');
    expect(engine.equipSatellite('owner', pickup.id)).toBe(true);
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('orbiting');
    engine.updatePlayer('owner', { position: { x: 0, y: 0 } });
    engine.tickSatellitePickups();
    return pickup.id;
  }

  function addAttacker(): void {
    engine.addPlayer(
      'attacker',
      'Attacker',
      new RecordingSocket(),
      { x: 1000, y: 1000 },
      'surveyor'
    );
    engine.updatePlayer('attacker', { spawnProtectionTimer: 0 });
    clearAsteroids(engine);
  }

  test('a player laser passes through an owned pickup and its owner hull', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;
    const pickupHealth = engine.getSatellitePickup(pickupId)?.health;

    engine.spawnLaser('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
    engine.advanceLasersAndResolveHits(1_000);

    expect(engine.getSatellitePickup(pickupId)?.health).toBe(pickupHealth);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
    expect(engine.getServerLasers()).toHaveLength(1);
  });

  test('a player laser that misses the pickup also passes through the owner hull', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;
    const pickupHealth = engine.getSatellitePickup(pickupId)?.health;

    engine.spawnLaser('attacker', { x: 0, y: -120 }, { x: 0, y: 240 });
    engine.advanceLasersAndResolveHits(1_000);

    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
    expect(engine.getSatellitePickup(pickupId)?.health).toBe(pickupHealth);
    expect(engine.getServerLasers()).toHaveLength(1);
  });

  test('ordinary pickup damage still breaks the pickup while the owner remains unharmed by a player laser', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;

    expect(engine.handleSatellitePickupDamage(pickupId, DAMAGE.LASER_HIT)).not.toBeNull();
    expect(engine.handleSatellitePickupDamage(pickupId, DAMAGE.LASER_HIT)?.state).toBe('broken');

    expect(engine.getSatellitePickup(pickupId)?.state).toBe('broken');
    expect(engine.getSatellitePickup(pickupId)?.health).toBe(0);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);

    engine.spawnLaser('attacker', { x: 0, y: -120 }, { x: 0, y: 240 });
    engine.advanceLasersAndResolveHits(1_100);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
  });

  test('asteroids and shots pass through loose pickups without damaging or moving them', () => {
    addOwner();
    const pickup = engine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    engine.addAsteroid(asteroidAt('pickup-rock', pickup.position));
    engine.resolveAuthoritativeCombat();
    engine.resolveAuthoritativeCombat();
    expect(engine.getSatellitePickup(pickup.id)).toEqual(pickup);
    expect(engine.getAsteroid('pickup-rock')).toBeDefined();
    clearAsteroids(engine);
    for (const bounces of [0, 1]) {
      const shot = engine.spawnLaser(
        'owner',
        { x: pickup.position.x - 60, y: pickup.position.y },
        { x: 120, y: 0 }
      );
      assert.ok(shot);
      shot.bounces = bounces;
      engine.advanceLasersAndResolveHits();
      expect(shot.hasExploded).toBe(false);
      expect(engine.getSatellitePickup(pickup.id)).toEqual(pickup);
    }
  });

  test('an equipped satellite takes asteroid damage and breaks after two impacts', () => {
    addOwner();
    const id = attachFirstPickup();
    const pickup = engine.getSatellitePickup(id);
    assert.ok(pickup);
    engine.addAsteroid(asteroidAt('pickup-rock', pickup.position));
    engine.resolveAuthoritativeCombat();
    expect(engine.getSatellitePickup(id)?.health).toBe(pickup.health - DAMAGE.LASER_HIT);
    engine.resolveAuthoritativeCombat();
    expect(engine.getSatellitePickup(id)?.state).toBe('broken');
  });

  test('a ricochet strikes an equipped satellite before reaching its owner', () => {
    addOwner();
    const id = attachFirstPickup();
    addAttacker();
    const health = engine.getPlayer('owner')?.health;
    const pickup = engine.getSatellitePickup(id);
    assert.ok(pickup);
    const shot = engine.spawnLaser('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
    assert.ok(shot);
    shot.bounces = 1;
    engine.advanceLasersAndResolveHits();
    expect(engine.getSatellitePickup(id)?.health).toBe(pickup.health - DAMAGE.LASER_HIT);
    expect(engine.getPlayer('owner')?.health).toBe(health);
    expect(shot.hasExploded).toBe(true);
  });
});
