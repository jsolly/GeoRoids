import { describe, expect, test } from 'vitest';
import { SATELLITE } from '../../../src/constants';
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
