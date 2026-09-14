import { expect, test } from 'vitest';
import { WORLD } from '../../../shared/world';
import { Laser } from '../../../src/entities/laser/Laser';

test('a locally predicted shot ricochets at the wall without changing its speed', () => {
  const laser = new Laser({ x: WORLD.radius - 10, y: 0 }, { x: 40, y: 0 }, 0, 0);
  laser.move();
  expect(laser.position.x).toBeCloseTo(WORLD.radius - 30, 3);
  expect(laser.velocity).toEqual({ x: -40, y: 0 });
  expect(laser.bounceCount).toBe(1);
  expect(laser.distTraveled).toBe(40);
  laser.move();
  expect(laser.position.x).toBeCloseTo(WORLD.radius - 70, 3);
  expect(laser.bounceCount).toBe(1);
});

test('an oblique wall ricochet keeps its tangential motion and remains inside the world', () => {
  const laser = new Laser({ x: WORLD.radius - 10, y: 0 }, { x: 40, y: 30 }, 0, 0);
  laser.move();
  expect(laser.velocity.x).toBeLessThan(0);
  expect(laser.velocity.y).toBeGreaterThan(0);
  expect(Math.hypot(laser.velocity.x, laser.velocity.y)).toBeCloseTo(50, 8);
  expect(Math.hypot(laser.position.x, laser.position.y)).toBeLessThan(WORLD.radius);
  expect(laser.position.y).toBeCloseTo(30, 1);
});

test('a shot starting exactly on the boundary reflects once and continues inward', () => {
  const laser = new Laser({ x: WORLD.radius, y: 0 }, { x: 40, y: 0 }, 0, 0);
  laser.move();
  expect(laser.bounceCount).toBe(1);
  expect(laser.position.x).toBeCloseTo(WORLD.radius - 40, 3);
  laser.move();
  expect(laser.bounceCount).toBe(1);
});
