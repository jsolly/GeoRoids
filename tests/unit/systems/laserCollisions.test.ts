import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Laser } from '../../../src/entities/laser/Laser';
import type { Roid } from '../../../src/entities/roid/Roid';
import type { Ship } from '../../../src/entities/ship/Ship';
import {
  checkLaserHit,
  checkLaserShipCollision,
} from '../../../src/physics/collision/collisionDetection';

describe('Laser Collision Detection', () => {
  let mockLaser: Laser;
  let mockAsteroid: Roid;
  let mockShip: Ship;

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

    // Create mock ship
    mockShip = {
      position: { x: 100, y: 100 },
      r: 15,
      id: 'test-ship',
      health: 100,
      exploding: false,
    } as Ship;
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
      // Position laser at the edge of asteroid (radius 20 + laser radius 2 = 22)
      // Use 21.9 to be just inside the collision boundary
      mockLaser.position = { x: 100 + 21.9, y: 100 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true);
    });

    test('laser misses asteroid when just outside edge', () => {
      // Position laser just outside asteroid edge
      mockLaser.position = { x: 100 + 22.1, y: 100 };
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(false);
    });

    test('laser collision works with different asteroid sizes', () => {
      // Test with large asteroid
      mockAsteroid.r = 40;
      mockLaser.position = { x: 100 + 41.9, y: 100 }; // Just inside collision boundary
      expect(checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r)).toBe(true);

      // Test with small asteroid
      mockAsteroid.r = 10;
      mockLaser.position = { x: 100 + 11.9, y: 100 }; // Just inside collision boundary
      expect(checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r)).toBe(true);
    });
  });

  describe('Laser vs Ship Collisions', () => {
    test('laser hits ship when positions overlap', () => {
      const result = checkLaserShipCollision(mockLaser.position, mockShip.position, mockShip.r);
      expect(result).toBe(true);
    });

    test('laser misses ship when positions are far apart', () => {
      mockLaser.position = { x: 200, y: 200 };
      const result = checkLaserShipCollision(mockLaser.position, mockShip.position, mockShip.r);
      expect(result).toBe(false);
    });

    test('laser hits ship when just touching edge', () => {
      // Position laser at the edge of ship (radius 15 + laser radius 2 = 17)
      // Use 16.9 to be just inside the collision boundary
      mockLaser.position = { x: 100 + 16.9, y: 100 };
      const result = checkLaserShipCollision(mockLaser.position, mockShip.position, mockShip.r);
      expect(result).toBe(true);
    });

    test('laser misses ship when just outside edge', () => {
      // Position laser just outside ship edge
      mockLaser.position = { x: 100 + 17.1, y: 100 };
      const result = checkLaserShipCollision(mockLaser.position, mockShip.position, mockShip.r);
      expect(result).toBe(false);
    });

    test('laser collision works with different ship sizes', () => {
      // Test with larger ship
      mockShip.r = 25;
      mockLaser.position = { x: 100 + 26.9, y: 100 }; // Just inside collision boundary
      expect(checkLaserShipCollision(mockLaser.position, mockShip.position, mockShip.r)).toBe(true);

      // Test with smaller ship
      mockShip.r = 8;
      mockLaser.position = { x: 100 + 9.9, y: 100 }; // Just inside collision boundary
      expect(checkLaserShipCollision(mockLaser.position, mockShip.position, mockShip.r)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('laser collision works with zero radius objects', () => {
      mockAsteroid.r = 0;
      mockLaser.position = { x: 100, y: 100 }; // Exact same position
      const result = checkLaserHit(mockLaser.position, mockAsteroid.position, mockAsteroid.r);
      expect(result).toBe(true); // Laser radius (2) should still hit
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
