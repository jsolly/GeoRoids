import { expect, test } from 'vitest';
import { applyQuakeImpulse } from '../../../src/entities/ship/quakeImpulse';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';

test('a fast incoming target is thrown outward while sideways momentum survives', () => {
  const body = { position: { x: 100, y: 0 }, velocity: { x: -50, y: 4 } };
  expect(applyQuakeImpulse(body, { x: 0, y: 0 })).toBe(true);
  expect(body.velocity.x).toBeGreaterThan(20);
  expect(body.velocity.y).toBe(4);
});

test('targets at the edge still receive a violent kick but targets outside do not move', () => {
  const edge = { position: { x: 0, y: SHIP_ABILITY.SHOCK_RADIUS }, velocity: { x: 0, y: 0 } };
  const outside = {
    position: { x: SHIP_ABILITY.SHOCK_RADIUS + 1, y: 0 },
    velocity: { x: 2, y: 3 },
  };
  expect(applyQuakeImpulse(edge, { x: 0, y: 0 })).toBe(true);
  expect(edge.velocity.y).toBe(12);
  expect(applyQuakeImpulse(outside, { x: 0, y: 0 })).toBe(false);
  expect(outside.velocity).toEqual({ x: 2, y: 3 });
});

test('a target overlapping the caster still gets a finite outward kick', () => {
  const body = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
  applyQuakeImpulse(body, { x: 0, y: 0 }, Math.PI / 2);
  expect(body.velocity.x).toBeCloseTo(0);
  expect(body.velocity.y).toBe(-24);
});
