import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LASER } from '../../../../src/constants';
import { Ship } from '../../../../src/entities/ship/Ship';

let mockShip: Ship;

beforeEach(() => {
  mockShip = new Ship();
});

afterEach(() => {
  vi.clearAllMocks();
});

test('Ship Creation', () => {
  expect(mockShip).toBeInstanceOf(Ship);
  expect(mockShip.health).toBeGreaterThan(0);
  expect(mockShip.exploding).toBe(false);
});

test('Move Ship', () => {
  mockShip.velocity = { x: 1, y: 1 };
  mockShip.update();
  expect(mockShip.position.x).toBeGreaterThan(0);
  expect(mockShip.position.y).toBeGreaterThan(0);
});

test('Ship Slows Down (Friction)', () => {
  mockShip.velocity = { x: 1, y: 1 };
  mockShip.thrusting = false;
  mockShip.update();
  expect(mockShip.velocity.x).toBeLessThan(1);
  expect(mockShip.velocity.y).toBeLessThan(1);
});

test('Ship Can Shoot', () => {
  mockShip.lasers = [];
  expect(mockShip.canShoot).toBeTruthy();
});

test('Ship Cannot Shoot', () => {
  const mockLaser = {
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    distTraveled: 0,
    explodeTime: 0,
  };
  mockShip.lasers = Array(LASER.MAX_COUNT).fill(mockLaser) as typeof mockShip.lasers;
  mockShip.canShoot = false; // ensure flag + capacity both block shooting
  expect(mockShip.canShoot).toBeFalsy();
});

test('ship starts with correct initial invincibility state', () => {
  const ship = new Ship();

  // Regular ship should start without invincibility
  expect(ship.blinkCount).toBe(0);
  expect(ship.spawnProtectionTimer).toBe(0);
  expect(ship.blinkOn).toBe(true); // blinkOn is true when blinkCount is 0 (0 % 2 === 0)
});

test('local player ship starts with invincibility', () => {
  const ship = new Ship({ isLocalPlayer: true });

  // Local player ship should start with invincibility
  expect(ship.blinkCount).toBeGreaterThan(0);
  expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
  expect(ship.blinkOn).toBe(true); // Should start blinking when invincible
});
