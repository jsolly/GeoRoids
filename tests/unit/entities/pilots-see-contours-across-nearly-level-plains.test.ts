import { expect, test } from 'vitest';
import { extractIsoContours } from '../../../src/physics/terrain/contours';
import {
  createHeightfield,
  sampleGradient,
  sampleHeight,
} from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import { terrainCruiseVelocity } from '../../../src/physics/terrain/terrainTravel';
import { collectElevationLabels } from '../../../src/rendering/contourLabels';

test('plains show many distinct contours while retaining ordinary cruise', () => {
  const field = ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 60000 });
  const levels = extractIsoContours(field, 192, 18, { cx: -2100, cy: 700, radius: 1600 });
  const plains = levels.filter(
    (level) => Math.abs(level.height) > 0 && Math.abs(level.height) < 0.002
  );
  expect(plains.length).toBeGreaterThanOrEqual(3);
  expect(plains.reduce((sum, level) => sum + level.segments.length, 0)).toBeGreaterThan(200);
  expect(
    new Set(collectElevationLabels(plains, 100).map((label) => label.text)).size
  ).toBeGreaterThanOrEqual(3);
  let checked = 0;
  for (const level of plains) {
    for (const segment of level.segments) {
      const position = { x: (segment.ax + segment.bx) / 2, y: (segment.ay + segment.by) / 2 };
      if (Math.abs(sampleHeight(field, position.x, position.y)) >= 0.0015) {
        continue;
      }
      const gradient = sampleGradient(field, position.x, position.y);
      expect(Math.hypot(gradient.x, gradient.y)).toBeLessThan(TERRAIN.TRAVEL_FLAT_GRADIENT);
      const velocity = terrainCruiseVelocity(position, 0, 1);
      // Tiny elevation differences preserve ordinary cruise.
      if (Math.abs(velocity.y) < 1e-10 && Math.abs(velocity.x - 1) < 1e-10) {
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(100);
});

test('the same broad hills and valleys remain pronounced beside tiny plain relief', () => {
  const field = createHeightfield(TERRAIN.DEFAULT_SEED, { radius: 3100 });
  const heights: number[] = [];
  for (let x = -2500; x <= 2500; x += 173) {
    for (let y = -2500; y <= 2500; y += 173) {
      heights.push(sampleHeight(field, x, y));
    }
  }
  expect(Math.max(...heights)).toBeGreaterThan(0.1);
  expect(Math.min(...heights)).toBeLessThan(-0.1);
  expect(Math.hypot(...Object.values(sampleGradient(field, 0, 0)))).toBeLessThan(1e-6);
});
