import { describe, expect, test } from 'vitest';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
import { SatelliteManager } from '../../../server/core/SatelliteManager';
import { SatellitePickupManager } from '../../../server/core/SatellitePickupManager';

describe('Quake pulse auxiliary bodies', () => {
  test('kicks loot through the expiry update and damps the motion', () => {
    const manager = new LootManager(new RNGService(11));
    const drop = manager.spawnShard({ x: 120, y: 0 }, 100);

    expect(manager.applyQuakePulse({ x: 0, y: 0 }, 0)).toBe(1);
    manager.expire(101);
    const first = manager.get(drop.id);
    expect(first).toBeDefined();
    expect(first?.position.x).toBeGreaterThan(drop.position.x);
    const firstStep = (first?.position.x ?? 0) - drop.position.x;

    manager.expire(102);
    const second = manager.get(drop.id);
    expect(second).toBeDefined();
    const secondStep = (second?.position.x ?? 0) - (first?.position.x ?? 0);
    expect(secondStep).toBeGreaterThan(0);
    expect(secondStep).toBeLessThan(firstStep);
  });

  test('keeps an NPC satellite pulse after the orbit update overwrites its base velocity', () => {
    const manager = new SatelliteManager(new RNGService(12));
    const created = manager.createSatellites(1)[0];
    expect(created).toBeDefined();
    if (!created) {
      return;
    }
    const satellite = manager.getSatellite(created.id);
    expect(satellite).toBeDefined();
    if (!satellite) {
      return;
    }

    satellite.position = { x: 0, y: 0 };
    satellite.orbitCenter = { x: 0, y: 0 };
    satellite.orbitPhase = 0;
    satellite.velocity = { x: 0, y: 0 };
    expect(manager.applyQuakePulse({ x: 0, y: 0 }, 0)).toBe(1);
    expect(satellite.velocity.x).toBeCloseTo(24);

    manager.update([]);
    const afterFirst = manager.getSatellite(created.id);
    expect(afterFirst).toBeDefined();
    expect(afterFirst?.position.x).toBeGreaterThan(20);
    const firstPositionX = afterFirst?.position.x ?? 0;
    const firstKnockback = afterFirst?.quakeMotion.velocity.x ?? 0;

    manager.update([]);
    const afterSecond = manager.getSatellite(created.id);
    expect(afterSecond).toBeDefined();
    expect(afterSecond?.position.x).toBeGreaterThan(firstPositionX);
    expect(afterSecond?.quakeMotion.velocity.x).toBeCloseTo(firstKnockback * 0.92);
  });

  test('kicks active satellite projectiles through their authoritative movement loop', () => {
    const manager = new SatelliteManager(new RNGService(13));
    const created = manager.createSatellites(1)[0];
    expect(created).toBeDefined();
    if (!created) {
      return;
    }
    const satellite = manager.getSatellite(created.id);
    expect(satellite).toBeDefined();
    if (!satellite) {
      return;
    }
    satellite.position = { x: 0, y: 0 };
    satellite.orbitCenter = { x: 0, y: 0 };
    satellite.orbitPhase = 0;
    satellite.shootCooldown = 0;
    satellite.burstRemaining = 0;
    satellite.burstCooldown = 0;

    manager.update([
      {
        id: 'pilot',
        position: { x: 300, y: 0 },
        radius: 15,
        health: 100,
        exploding: false,
      },
    ]);
    const before = manager.getActiveProjectiles()[0];
    expect(before).toBeDefined();
    if (!before) {
      return;
    }
    const beforeVelocity = before.velocity.x;
    expect(manager.applyQuakePulse(before.position, 0)).toBeGreaterThanOrEqual(1);
    const kicked = manager.getActiveProjectiles()[0];
    expect(kicked?.velocity.x).toBeGreaterThan(beforeVelocity);

    manager.update([]);
    const moved = manager.getActiveProjectiles()[0];
    expect(moved?.position.x).toBeGreaterThan(before.position.x);
  });

  test('kicks an orbiting satellite pickup without losing its owner link', () => {
    const manager = new SatellitePickupManager(new RNGService(14));
    const created = manager.createPickups(1)[0];
    expect(created).toBeDefined();
    if (!created) {
      return;
    }
    const pickup = manager.getPickup(created.id);
    expect(pickup).toBeDefined();
    if (!pickup) {
      return;
    }
    const collected = manager.collect(
      pickup.id,
      { id: 'pilot', position: { x: 0, y: 0 }, radius: 15, health: 100, exploding: false },
      0
    );
    expect(collected?.state).toBe('orbiting');
    expect(manager.applyQuakePulse({ x: 0, y: 0 }, 0)).toBe(1);

    const before = { ...pickup.position };
    manager.update([
      { id: 'pilot', position: { x: 0, y: 0 }, radius: 15, health: 100, exploding: false },
    ]);
    expect(pickup.ownerId).toBe('pilot');
    expect(Math.hypot(pickup.position.x - before.x, pickup.position.y - before.y)).toBeGreaterThan(
      10
    );
  });
});
