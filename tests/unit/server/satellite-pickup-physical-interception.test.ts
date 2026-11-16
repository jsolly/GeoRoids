/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { DAMAGE } from '../../../shared/constants/gameplay';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function clearAsteroids(engine: GameEngine): void {
  for (const asteroid of engine.getAllAsteroids()) {
    engine.asteroidLifecycle.remove(asteroid.id);
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
    engine.addPlayer('owner', 'Owner', new RecordingSocket(), { x: 0, y: 0 }, 'scout');
    engine.updatePlayer('owner', { spawnProtectionTimer: 0 });
    clearAsteroids(engine);
  }

  function attachFirstPickup(): string {
    const pickup = engine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    engine.updatePlayer('owner', {
      position: { x: pickup.position.x + 110, y: pickup.position.y },
    });
    engine.satelliteField.advance();
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('stored');
    expect(engine.equipSatellite('owner', pickup.id)).toBe(true);
    expect(engine.getSatellitePickup(pickup.id)?.state).toBe('orbiting');
    engine.updatePlayer('owner', { position: { x: 0, y: 0 } });
    engine.satelliteField.advance();
    return pickup.id;
  }

  function addAttacker(): void {
    engine.addPlayer('attacker', 'Attacker', new RecordingSocket(), { x: 1000, y: 1000 }, 'scout');
    engine.updatePlayer('attacker', { spawnProtectionTimer: 0 });
    clearAsteroids(engine);
  }

  test('a player laser passes through an owned pickup and its owner hull', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;
    const pickupHealth = engine.getSatellitePickup(pickupId)?.health;

    engine.laserCombat.spawn('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
    engine.laserCombat.advance(1_000);

    expect(engine.getSatellitePickup(pickupId)?.health).toBe(pickupHealth);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
    expect(engine.laserCombat.shots()).toHaveLength(1);
  });

  test('a player laser that misses the pickup also passes through the owner hull', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;
    const pickupHealth = engine.getSatellitePickup(pickupId)?.health;

    engine.laserCombat.spawn('attacker', { x: 0, y: -120 }, { x: 0, y: 240 });
    engine.laserCombat.advance(1_000);

    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
    expect(engine.getSatellitePickup(pickupId)?.health).toBe(pickupHealth);
    expect(engine.laserCombat.shots()).toHaveLength(1);
  });

  test('ordinary pickup damage still breaks the pickup while the owner remains unharmed by a player laser', () => {
    addOwner();
    const pickupId = attachFirstPickup();
    addAttacker();
    const ownerHealth = engine.getPlayer('owner')?.health;

    expect(engine.satellitePickupManager.damage(pickupId, DAMAGE.LASER_HIT)).not.toBeNull();
    expect(engine.satellitePickupManager.damage(pickupId, DAMAGE.LASER_HIT)?.state).toBe('broken');

    expect(engine.getSatellitePickup(pickupId)?.state).toBe('broken');
    expect(engine.getSatellitePickup(pickupId)?.health).toBe(0);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);

    engine.laserCombat.spawn('attacker', { x: 0, y: -120 }, { x: 0, y: 240 });
    engine.laserCombat.advance(1_100);
    expect(engine.getPlayer('owner')?.health).toBe(ownerHealth);
  });

  test('asteroids and shots pass through loose pickups without damaging or moving them', () => {
    addOwner();
    const pickup = engine.getAllSatellitePickups()[0];
    assert.ok(pickup);
    engine.asteroidLifecycle.insert(asteroidAt('pickup-rock', pickup.position));
    engine.contactCombat.advance();
    engine.contactCombat.advance();
    expect(engine.getSatellitePickup(pickup.id)).toEqual(pickup);
    expect(engine.getAsteroid('pickup-rock')).toBeDefined();
    clearAsteroids(engine);
    for (const bounces of [0, 1]) {
      const shot = engine.laserCombat.spawn(
        'owner',
        { x: pickup.position.x - 60, y: pickup.position.y },
        { x: 120, y: 0 }
      );
      assert.ok(shot);
      shot.bounces = bounces;
      engine.laserCombat.advance();
      expect(shot.hasExploded).toBe(false);
      expect(engine.getSatellitePickup(pickup.id)).toEqual(pickup);
    }
  });

  test('an equipped satellite takes asteroid damage and breaks after two impacts', () => {
    addOwner();
    const id = attachFirstPickup();
    const pickup = engine.getSatellitePickup(id);
    assert.ok(pickup);
    engine.asteroidLifecycle.insert(asteroidAt('pickup-rock', pickup.position));
    const allRocks = vi.spyOn(AsteroidManager.prototype, 'getAllAsteroids');
    try {
      engine.contactCombat.advance();
      expect(engine.getSatellitePickup(id)?.health).toBe(pickup.health - DAMAGE.LASER_HIT);
      engine.contactCombat.advance();
      expect(engine.getSatellitePickup(id)?.state).toBe('broken');
      expect(allRocks).not.toHaveBeenCalled();
    } finally {
      allRocks.mockRestore();
    }
  });

  test('a ricochet strikes an equipped satellite before reaching its owner', () => {
    addOwner();
    const id = attachFirstPickup();
    addAttacker();
    const health = engine.getPlayer('owner')?.health;
    const pickup = engine.getSatellitePickup(id);
    assert.ok(pickup);
    const shot = engine.laserCombat.spawn('attacker', { x: 120, y: 0 }, { x: -240, y: 0 });
    assert.ok(shot);
    shot.bounces = 1;
    engine.laserCombat.advance();
    expect(engine.getSatellitePickup(id)?.health).toBe(pickup.health - DAMAGE.LASER_HIT);
    expect(engine.getPlayer('owner')?.health).toBe(health);
    expect(shot.hasExploded).toBe(true);
  });
});
