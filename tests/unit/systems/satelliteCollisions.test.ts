import { describe, expect, test, vi } from 'vitest';
import { SATELLITE } from '../../../src/constants';
import { Laser } from '../../../src/entities/laser/Laser';
import type { Satellite } from '../../../src/entities/satellite/Satellite';
import { Ship } from '../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';
import {
  checkLaserShipCollision,
  checkShipCollision,
} from '../../../src/physics/collision/collisionDetection';

describe('satellite collision geometry', () => {
  test('a laser overlapping a satellite hull counts as a hit', () => {
    expect(
      checkLaserShipCollision({ x: 100, y: 100 }, { x: 100, y: 100 }, SATELLITE.SIZE / 2)
    ).toBe(true);
  });

  test('a distant laser misses the satellite', () => {
    expect(
      checkLaserShipCollision({ x: 400, y: 400 }, { x: 100, y: 100 }, SATELLITE.SIZE / 2)
    ).toBe(false);
  });

  test('a ship overlapping a satellite hull collides', () => {
    expect(checkShipCollision({ x: 10, y: 0 }, 15, { x: 0, y: 0 }, SATELLITE.SIZE / 2)).toBe(true);
  });
});

describe('satellite laser shield visuals', () => {
  test('a swept EO bolt reflects at the F shield and keeps its remaining path', () => {
    const ship = new Ship();
    ship.id = 'shielded-ship';
    ship.position = { x: 0, y: 0 };
    ship.shieldActive = true;
    ship.shieldTime = 30;
    const laser = new Laser({ x: -40, y: 0 }, { x: 80, y: 0 }, 0, 0);
    laser.position = { x: 40, y: 0 };
    vi.spyOn(laser, 'playHitSound').mockImplementation(() => undefined);
    const satellite = { lasers: [laser] } as unknown as Satellite;

    CollisionManager.getInstance().checkSatelliteLaserCollisions([satellite], ship);

    expect(laser.hasExploded).toBe(false);
    expect(laser.bounceCount).toBe(1);
    expect(laser.lastShieldId).toBe(ship.id);
    expect(laser.velocity.x).toBeLessThan(0);
    expect(Math.hypot(laser.velocity.x, laser.velocity.y)).toBe(80);
    expect(laser.prevPosition.x).toBeCloseTo(-ship.r * 1.55, 5);
    expect(laser.position.x).toBeCloseTo(-40 - 2 * ship.r * 1.55, 5);
  });

  test('a projected E shield reflects the same radius without removing the bolt', () => {
    const ship = new Ship();
    ship.id = 'projected-ship';
    ship.position = { x: 0, y: 0 };
    ship.shieldTimer = 12;
    const laser = new Laser({ x: -40, y: 0 }, { x: 80, y: 0 }, 0, 0);
    laser.position = { x: 40, y: 0 };
    vi.spyOn(laser, 'playHitSound').mockImplementation(() => undefined);
    const satellite = { lasers: [laser] } as unknown as Satellite;

    CollisionManager.getInstance().checkSatelliteLaserCollisions([satellite], ship);

    expect(laser.hasExploded).toBe(false);
    expect(laser.bounceCount).toBe(1);
    expect(laser.velocity.x).toBeLessThan(0);
    expect(laser.prevPosition.x).toBeCloseTo(-ship.r * 1.55, 5);
  });
});
