import { expect, test } from 'vitest';
import { sampleHeight } from '../../../src/physics/terrain/heightfield';
import { samplePassages } from '../../../src/physics/terrain/passages';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import {
  terrainCruiseVelocity,
  terrainSpeedLimit,
} from '../../../src/physics/terrain/terrainTravel';

test('narrow cuts keep their contour shape while all directions use the same cruise floor and ceiling', () => {
  const terrain = ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 60000 });
  expect(samplePassages(terrain, 0, 0).every((route) => route.strength === 0)).toBe(true);
  const spawn = terrainCruiseVelocity({ x: 0, y: 0 }, 0, 1);
  expect(spawn.x).toBe(1);
  expect(spawn.y).toBeCloseTo(0, 10);
  for (let x = 1500; x < 4000; x += 71) {
    for (let y = 0; y < 1100; y++) {
      const [route, crossing] = samplePassages(terrain, x, y);
      if (route.strength <= 0.999 || crossing.strength !== 0) {
        continue;
      }
      const centerHeight = Math.abs(sampleHeight(terrain, x, y));
      const banks = [-150, 150].map((offset) => Math.abs(sampleHeight(terrain, x, y + offset)));
      expect(Math.max(...banks)).toBeGreaterThan(centerHeight * 2);
      for (const angle of [0, 0.7, 1.8, 3.9, 5.2]) {
        const velocity = terrainCruiseVelocity({ x, y }, angle, 1);
        expect(Math.hypot(velocity.x, velocity.y)).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(Math.hypot(velocity.x, velocity.y)).toBeLessThanOrEqual(
          terrainSpeedLimit({ x, y }, 1) + 1e-9
        );
      }
      return;
    }
  }
  throw new Error('No passage center found');
});
