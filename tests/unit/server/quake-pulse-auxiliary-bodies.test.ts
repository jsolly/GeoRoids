import { describe, expect, test } from 'vitest';
import { LootManager } from '../../../server/core/LootManager';
import { RNGService } from '../../../server/core/RNGService';
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
