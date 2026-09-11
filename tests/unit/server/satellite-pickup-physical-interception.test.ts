/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { SatelliteManager } from '../../../server/core/SatelliteManager';
import type { AsteroidData } from '../../../shared-types';
import { DAMAGE, SATELLITE_PICKUP } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function clearAsteroids(engine: GameEngine): void {
  for (const asteroid of engine.getAllAsteroids()) {
    engine.removeAsteroid(asteroid.id);
  }
}

function clearSatellites(engine: GameEngine): void {
  engine.createSatellites(0);
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
      'dart',
      'ion'
    );
    engine.updatePlayer('owner', { spawnProtectionTimer: 0 });
    clearAsteroids(engine);
    clearSatellites(engine);
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
      'dart',
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

describe('EO projectiles choose the nearest swept body', () => {
  test('a projectile can hit an un-aimable pickup on its way to a farther ship', () => {
    const manager = new SatelliteManager(new RNGService(77));
    const satellite = manager.createSatellites(1)[0];
    assert.ok(satellite);

    let shot = manager.getActiveProjectiles()[0];
    for (let frame = 0; frame < 240 && !shot; frame += 1) {
      manager.update([
        {
          id: 'ship',
          position: { x: satellite.position.x + 180, y: satellite.position.y },
          radius: 15,
          health: 100,
          exploding: false,
          kind: 'ship',
        },
      ]);
      shot = manager.getActiveProjectiles()[0];
    }
    assert.ok(shot, 'EO satellite produced a projectile');

    const endpoint = {
      x: shot.position.x + shot.velocity.x,
      y: shot.position.y + shot.velocity.y,
    };
    const fartherShip = {
      id: 'farther-ship',
      position: {
        x: endpoint.x + shot.velocity.x * 2,
        y: endpoint.y + shot.velocity.y * 2,
      },
      radius: 10,
      health: 100,
      exploding: false,
      kind: 'ship' as const,
    };
    const pickup = {
      id: 'pickup-body',
      position: endpoint,
      radius: SATELLITE_PICKUP.SIZE / 2,
      health: SATELLITE_PICKUP.HEALTH,
      exploding: false,
      aimable: false,
      kind: 'pickup' as const,
    };

    manager.update([fartherShip, pickup]);
    const hit = manager.drainHits()[0];
    expect(hit?.targetId).toBe(pickup.id);
    expect(hit?.targetKind).toBe('pickup');
  });

  test('EO satellites never fire when the only available body is a pickup', () => {
    const manager = new SatelliteManager(new RNGService(78));
    manager.createSatellites(1);
    const shots = manager.update([
      {
        id: 'pickup-body',
        position: { x: 0, y: 0 },
        radius: SATELLITE_PICKUP.SIZE / 2,
        health: SATELLITE_PICKUP.HEALTH,
        exploding: false,
        aimable: false,
        kind: 'pickup',
      },
    ]);

    expect(shots).toEqual([]);
  });

  test('a reflected EO projectile can return to its source satellite', () => {
    const manager = new SatelliteManager(new RNGService(79));
    const satellite = manager.createSatellites(1)[0];
    assert.ok(satellite);
    const sourcePosition = { x: -140, y: 0 };
    const internalSatellite = manager.getSatellite(satellite.id);
    assert.ok(internalSatellite);
    internalSatellite.position = { ...sourcePosition };
    internalSatellite.orbitCenter = { ...sourcePosition };
    internalSatellite.shootCooldown = 999;

    const projectile = {
      satelliteId: satellite.id,
      shotId: 'source-shot',
      position: { x: -100, y: 0 },
      velocity: { x: 100, y: 0 },
      age: 0,
      bounces: 0,
    };
    const internals = manager as unknown as { projectiles: Array<typeof projectile> };
    internals.projectiles.push(projectile);

    let shieldFlashCount = 0;
    const shieldedShip = {
      id: 'shielded-ship',
      position: { x: 0, y: 0 },
      radius: 20,
      health: 100,
      exploding: false,
      kind: 'ship' as const,
      shieldActive: true,
      shieldTime: 30,
      onShieldHit: () => {
        shieldFlashCount += 1;
      },
    };
    const sourceBody = {
      id: satellite.id,
      position: sourcePosition,
      radius: satellite.radius,
      health: satellite.health,
      exploding: false,
      aimable: false,
      kind: 'satellite' as const,
    };

    manager.update([sourceBody, shieldedShip]);
    expect(manager.drainHits()).toEqual([]);
    expect(shieldFlashCount).toBe(1);
    expect(manager.getActiveProjectiles()[0]?.velocity.x).toBeLessThan(0);

    manager.update([sourceBody, shieldedShip]);
    expect(manager.drainHits()).toEqual([
      {
        satelliteId: satellite.id,
        targetId: satellite.id,
        targetKind: 'satellite',
        damage: DAMAGE.LASER_HIT,
      },
    ]);
  });
});
