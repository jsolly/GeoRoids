import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LASER } from '../../../src/constants';
import type { Laser } from '../../../src/entities/laser/Laser';
import type { Roid } from '../../../src/entities/roid/Roid';
import { checkLaserHit } from '../../../src/physics/collision/collisionDetection';

describe('Laser Collision Detection', () => {
  let mockLaser: Laser;
  let mockAsteroid: Roid;

  beforeEach(() => {
    // Create mock laser
    mockLaser = {
      position: { x: 100, y: 100 },
      velocity: { x: 5, y: 0 },
      distTraveled: 0,
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
      move: vi.fn(),
      isExpired: vi.fn().mockReturnValue(false),
      shouldBeRemoved: vi.fn().mockReturnValue(false),
      playLaserSound: vi.fn(),
    } as unknown as Laser;

    // Create mock asteroid
    mockAsteroid = {
      position: { x: 100, y: 100 },
      r: 20,
      id: 'test-asteroid',
    } as Roid;
  });

  describe('Laser vs Asteroid Collisions', () => {
    test('laser hits asteroid when positions overlap', () => {
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true);
    });

    test('laser misses asteroid when positions are far apart', () => {
      mockLaser.position = { x: 200, y: 200 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(false);
    });

    test('laser hits asteroid when just touching edge', () => {
      const reach = mockAsteroid.r + LASER.HIT_RADIUS;
      mockLaser.position = { x: 100 + reach - 0.1, y: 100 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true);
    });

    test('laser misses asteroid when just outside edge', () => {
      const reach = mockAsteroid.r + LASER.HIT_RADIUS;
      mockLaser.position = { x: 100 + reach + 0.1, y: 100 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(false);
    });

    test('laser collision works with different asteroid sizes', () => {
      mockAsteroid.r = 40;
      mockLaser.position = { x: 100 + 40 + LASER.HIT_RADIUS - 0.1, y: 100 };
      expect(checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r)).toBe(true);

      mockAsteroid.r = 10;
      mockLaser.position = { x: 100 + 10 + LASER.HIT_RADIUS - 0.1, y: 100 };
      expect(checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('laser collision works with zero radius objects', () => {
      mockAsteroid.r = 0;
      mockLaser.position = { x: 100, y: 100 }; // Exact same position
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true); // Laser hit radius should still hit
    });

    test('laser collision works with negative coordinates', () => {
      mockLaser.position = { x: -100, y: -100 };
      mockAsteroid.position = { x: -100, y: -100 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true);
    });

    test('laser collision works with very large coordinates', () => {
      mockLaser.position = { x: 10000, y: 10000 };
      mockAsteroid.position = { x: 10000, y: 10000 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true);
    });
  });
});
