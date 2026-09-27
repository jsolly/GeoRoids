import { beforeEach, expect, test } from 'vitest';
import {
  CONTOUR_LOCK,
  contourLockDistance,
  contourLockSpeed,
  contourLockVelocity,
} from '../../../shared/contourLock';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { WORLD } from '../../../shared/world';
import { Ship } from '../../../src/entities/ship/Ship';
import { findContourCapture } from '../../../src/physics/terrain/contourCapture';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import { terrainSpeedLimit } from '../../../src/physics/terrain/terrainTravel';

beforeEach(() => ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius }));

function pilot(kitId: 'scout' | 'hauler' = 'scout'): Ship {
  const ship = new Ship({ position: { x: 1700, y: 3600 }, isLocalPlayer: true, kitId });
  for (let x = 1680; x <= 1720; x += 4) {
    ship.position.x = x;
    if (ship.canLockContour()) {
      return ship;
    }
  }
  throw new Error('Expected visible contour near fixture');
}

test.each(['scout', 'hauler'] as const)(
  '%s catches a nearby contour and follows its bends faster than free cruise',
  (kitId) => {
    const ship = pilot(kitId);
    const start = { ...ship.position };
    const baseline = cruiseSpeed(ship.mass, ship.maxVelocity);
    expect(ship.toggleContourLock()).toBe(true);
    const lock = ship.contourLock;
    if (!lock) {
      throw new Error('Expected lock');
    }
    for (let frame = 0; frame < 120; frame++) {
      ship.update();
      expect(ship.contourLock).toEqual(lock);
      if (frame >= 36) {
        expect(contourLockDistance(ship.position, lock)).toBeLessThan(CONTOUR_LOCK.railTolerance);
      }
    }
    expect(Math.hypot(ship.position.x - start.x, ship.position.y - start.y)).toBeGreaterThan(80);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(contourLockSpeed(baseline), 6);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeGreaterThan(
      terrainSpeedLimit(ship.position, baseline)
    );
    expect(ship.toggleContourLock()).toBe(false);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeLessThanOrEqual(
      terrainSpeedLimit(ship.position, baseline) + 1e-8
    );
    expect(ship.toggleContourLock()).toBe(true);
  }
);

test('empty space cannot be used as an at-will speed burst', () => {
  const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true });
  expect(ship.canLockContour()).toBe(false);
  expect(ship.toggleContourLock()).toBe(false);
  expect(findContourCapture({ x: WORLD.radius + 100, y: 0 }, 0)).toBe(null);
});

test('opposite headings catch the same visible contour in opposite directions', () => {
  const ship = pilot();
  const forward = findContourCapture(ship.position, ship.angle);
  const reverse = findContourCapture(ship.position, ship.angle + Math.PI);
  expect(forward?.height).toBe(reverse?.height);
  expect(forward?.direction).toBe(-(reverse?.direction ?? 0));
});

test('menu locks, death, and a blast release the rail and do not silently recapture it', () => {
  for (const stop of ['menu', 'death', 'blast'] as const) {
    const ship = pilot();
    expect(ship.toggleContourLock()).toBe(true);
    if (stop === 'menu') {
      ship.movementLocked = true;
    }
    if (stop === 'death') {
      ship.health = 0;
    }
    if (stop === 'blast') {
      ship.knockbackVelocityLimit = 12;
      ship.velocity = { x: 0, y: 12 };
    }
    ship.update();
    expect(ship.contourLock).toBe(null);
    if (stop === 'blast') {
      expect(ship.velocity.y).toBeGreaterThan(4);
    }
  }
});

test('rail guidance refuses a faraway level rather than snapping across empty space', () => {
  const ship = pilot();
  expect(contourLockVelocity(ship.position, { height: 100, direction: 1 }, 4)).toBe(null);
});

test('a surviving laser impact releases the rail immediately', () => {
  const ship = pilot();
  expect(ship.toggleContourLock()).toBe(true);
  ship.takeDamage(1, 'laser');
  expect(ship.health).toBeGreaterThan(0);
  expect(ship.contourLocked).toBe(false);
});
