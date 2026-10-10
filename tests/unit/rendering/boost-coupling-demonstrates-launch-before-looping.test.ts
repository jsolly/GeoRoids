import { expect, test } from 'vitest';
import {
  BOOST_COUPLING_DEMO_DURATION_MS,
  getBoostCouplingDemoFrame,
} from '../../../src/rendering/shipSchematicCanvas';

test('Boost Coupling turns the demonstration roid, ignites, and boosts away before looping', () => {
  const turning = getBoostCouplingDemoFrame(600, 180, 48);
  expect(turning.phase).toBe('turning');
  expect(turning.cableVisible).toBe(true);
  expect(turning.rockAngle).toBeGreaterThan(0);
  expect(turning.flameStrength).toBe(0);

  const igniting = getBoostCouplingDemoFrame(950, 180, 48);
  expect(igniting.phase).toBe('igniting');
  expect(igniting.rockAngle).toBeCloseTo(Math.PI / 2);
  expect(igniting.cableVisible).toBe(false);
  expect(igniting.flameStrength).toBeGreaterThan(0);

  const boosting = getBoostCouplingDemoFrame(1500, 180, 48);
  const coast = getBoostCouplingDemoFrame(2100, 180, 48);
  expect(boosting.phase).toBe('boosting');
  expect(boosting.rockX).toBeGreaterThan(igniting.rockX);
  expect(boosting.flameStrength).toBeGreaterThan(0);
  expect(coast.phase).toBe('coasting');
  expect(coast.rockX).toBeGreaterThan(boosting.rockX);

  const looped = getBoostCouplingDemoFrame(BOOST_COUPLING_DEMO_DURATION_MS + 600, 180, 48);
  expect(looped.phase).toBe(turning.phase);
  expect(looped.rockX).toBe(turning.rockX);
  expect(looped.rockAngle).toBe(turning.rockAngle);
});
