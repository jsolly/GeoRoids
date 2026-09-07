import { expect, test, describe } from 'vitest';
import {
  asteroidPointsForRadius,
  checkLaserAsteroidCollision,
  checkLaserAsteroidCollisionSwept,
  checkLaserHit,
  checkLaserShipCollision,
  isLaserNearAsteroid,
} from '../../../src/physics/collision/collisionDetection';

describe('Laser Collision Detection Functions', () => {
  describe('checkLaserAsteroidCollision', () => {
    test('returns true when laser and asteroid positions overlap', () => {
      const laserPos = { x: 100, y: 100 };
      const asteroidPos = { x: 100, y: 100 };
      const asteroidRadius = 20;

      const result = checkLaserAsteroidCollision(laserPos, asteroidPos, asteroidRadius);
      expect(result).toBe(true);
    });

    test('returns false when laser and asteroid are far apart', () => {
      const laserPos = { x: 200, y: 200 };
      const asteroidPos = { x: 100, y: 100 };
      const asteroidRadius = 20;

      const result = checkLaserAsteroidCollision(laserPos, asteroidPos, asteroidRadius);
      expect(result).toBe(false);
    });

    test('returns true when laser is just inside collision boundary', () => {
      const laserPos = { x: 100 + 21.9, y: 100 }; // Just inside (laser radius 2 + asteroid radius 20 = 22)
      const asteroidPos = { x: 100, y: 100 };
      const asteroidRadius = 20;

      const result = checkLaserAsteroidCollision(laserPos, asteroidPos, asteroidRadius);
      expect(result).toBe(true);
    });

    test('returns false when laser is just outside collision boundary', () => {
      const laserPos = { x: 100 + 22.1, y: 100 }; // Just outside
      const asteroidPos = { x: 100, y: 100 };
      const asteroidRadius = 20;

      const result = checkLaserAsteroidCollision(laserPos, asteroidPos, asteroidRadius);
      expect(result).toBe(false);
    });

    test('works with different asteroid sizes', () => {
      const asteroidPos = { x: 100, y: 100 };
      
      // Large asteroid (radius 40)
      const largeResult = checkLaserAsteroidCollision(
        { x: 100 + 41.9, y: 100 }, 
        asteroidPos, 
        40
      );
      expect(largeResult).toBe(true);

      // Small asteroid (radius 10)
      const smallResult = checkLaserAsteroidCollision(
        { x: 100 + 11.9, y: 100 }, 
        asteroidPos, 
        10
      );
      expect(smallResult).toBe(true);
    });

    test('works with negative coordinates', () => {
      const laserPos = { x: -100, y: -100 };
      const asteroidPos = { x: -100, y: -100 };
      const asteroidRadius = 20;

      const result = checkLaserAsteroidCollision(laserPos, asteroidPos, asteroidRadius);
      expect(result).toBe(true);
    });
  });

  describe('checkLaserAsteroidCollisionSwept', () => {
    test('detects a laser that tunnels through a small asteroid in one step', () => {
      const asteroidPos = { x: 100, y: 100 };
      const asteroidRadius = 8;
      const prev = { x: 70, y: 100 };
      const curr = { x: 130, y: 100 };

      expect(checkLaserAsteroidCollision(prev, asteroidPos, asteroidRadius)).toBe(false);
      expect(checkLaserAsteroidCollision(curr, asteroidPos, asteroidRadius)).toBe(false);
      expect(checkLaserAsteroidCollisionSwept(prev, curr, asteroidPos, asteroidRadius)).toBe(true);
    });

    test('misses when the swept path stays outside the asteroid', () => {
      const result = checkLaserAsteroidCollisionSwept(
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 20, y: 40 },
        8
      );
      expect(result).toBe(false);
    });
  });

  describe('isLaserNearAsteroid / asteroidPointsForRadius', () => {
    test('accepts a nearby reported hit and rejects a far phantom', () => {
      expect(isLaserNearAsteroid({ x: 110, y: 100 }, { x: 100, y: 100 }, 20)).toBe(true);
      expect(isLaserNearAsteroid({ x: 400, y: 400 }, { x: 100, y: 100 }, 20)).toBe(false);
    });

    test('scores large / medium / small roids like the client table', () => {
      expect(asteroidPointsForRadius(50)).toBe(20);
      expect(asteroidPointsForRadius(20)).toBe(50);
      expect(asteroidPointsForRadius(10)).toBe(100);
    });
  });

  describe('checkLaserShipCollision', () => {
    test('returns true when laser and ship positions overlap', () => {
      const laserPos = { x: 100, y: 100 };
      const shipPos = { x: 100, y: 100 };
      const shipRadius = 15;

      const result = checkLaserShipCollision(laserPos, shipPos, shipRadius);
      expect(result).toBe(true);
    });

    test('returns false when laser and ship are far apart', () => {
      const laserPos = { x: 200, y: 200 };
      const shipPos = { x: 100, y: 100 };
      const shipRadius = 15;

      const result = checkLaserShipCollision(laserPos, shipPos, shipRadius);
      expect(result).toBe(false);
    });

    test('returns true when laser is just inside collision boundary', () => {
      const laserPos = { x: 100 + 16.9, y: 100 }; // Just inside (laser radius 2 + ship radius 15 = 17)
      const shipPos = { x: 100, y: 100 };
      const shipRadius = 15;

      const result = checkLaserShipCollision(laserPos, shipPos, shipRadius);
      expect(result).toBe(true);
    });

    test('returns false when laser is just outside collision boundary', () => {
      const laserPos = { x: 100 + 17.1, y: 100 }; // Just outside
      const shipPos = { x: 100, y: 100 };
      const shipRadius = 15;

      const result = checkLaserShipCollision(laserPos, shipPos, shipRadius);
      expect(result).toBe(false);
    });

    test('works with different ship sizes', () => {
      const shipPos = { x: 100, y: 100 };
      
      // Large ship (radius 25)
      const largeResult = checkLaserShipCollision(
        { x: 100 + 26.9, y: 100 }, 
        shipPos, 
        25
      );
      expect(largeResult).toBe(true);

      // Small ship (radius 8)
      const smallResult = checkLaserShipCollision(
        { x: 100 + 9.9, y: 100 }, 
        shipPos, 
        8
      );
      expect(smallResult).toBe(true);
    });
  });

  describe('shared laser hit helper', () => {
    test('asteroid and ship wrappers match checkLaserHit', () => {
      const laserPos = { x: 10, y: 10 };
      const targetPos = { x: 12, y: 10 };
      expect(checkLaserAsteroidCollision(laserPos, targetPos, 20)).toBe(
        checkLaserHit(laserPos, targetPos, 20)
      );
      expect(checkLaserShipCollision(laserPos, targetPos, 15)).toBe(
        checkLaserHit(laserPos, targetPos, 15)
      );
    });
  });
});
