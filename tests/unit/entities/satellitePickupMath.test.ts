import { describe, expect, test } from 'vitest';
import { SATELLITE_PICKUP } from '../../../src/constants';
import {
  attachOrbitPosition,
  isWithinCollectRange,
  orbitOffset,
  spawnRingPosition,
  velocityFromDelta,
} from '../../../src/entities/satellitePickup/satellitePickupMath';

describe('satellite pickup orbit math', () => {
  test('orbitOffset traces a circle around the origin', () => {
    const start = orbitOffset(0, 40);
    const quarter = orbitOffset(Math.PI / 2, 40);

    expect(start.x).toBeCloseTo(40);
    expect(start.y).toBeCloseTo(0);
    expect(quarter.x).toBeCloseTo(0);
    expect(quarter.y).toBeCloseTo(-40);
  });

  test('attachOrbitPosition follows the owner', () => {
    const attached = attachOrbitPosition({ x: 100, y: 50 }, 0, 42);
    expect(attached.x).toBeCloseTo(142);
    expect(attached.y).toBeCloseTo(50);
  });

  test('isWithinCollectRange accepts nearby ships and rejects distant ones', () => {
    expect(isWithinCollectRange({ x: 0, y: 0 }, { x: 20, y: 0 }, 15, 9, 0)).toBe(true);
    expect(isWithinCollectRange({ x: 0, y: 0 }, { x: 400, y: 0 }, 15, 9, 50)).toBe(false);
  });

  test('velocityFromDelta is the per-frame step', () => {
    expect(velocityFromDelta({ x: 1, y: 2 }, { x: 4, y: 8 })).toEqual({ x: 3, y: 6 });
  });

  test('spawnRingPosition stays in the visible ring away from the spawn cluster', () => {
    const pos = spawnRingPosition(0, 2, () => 0.5);
    const dist = Math.hypot(pos.x, pos.y);
    expect(dist).toBeGreaterThanOrEqual(SATELLITE_PICKUP.SPAWN_RING_MIN);
    expect(dist).toBeLessThanOrEqual(SATELLITE_PICKUP.SPAWN_RING_MAX);
  });
});
