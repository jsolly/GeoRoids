import { expect, test } from 'vitest';
import { createHeightfield, sampleHeight } from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import {
  contourSlopeColor,
  previewConeWeight,
  radialSlope,
} from '../../../src/rendering/contourAppearance';
import { contourSlope } from '../../../src/rendering/contourDisplay';

test('steep climbs use very dark red and easy routes stay on the light red end', () => {
  const climb = contourSlopeColor(TERRAIN.TRAVEL_STEEP_GRADIENT, 0.55);
  const descent = contourSlopeColor(-TERRAIN.TRAVEL_STEEP_GRADIENT, 0.55);
  expect(climb).toBe('rgba(82, 10, 10, 0.55)');
  expect(descent).toBe('rgba(246, 182, 182, 0.55)');
  expect(contourSlopeColor(1, 0.55)).toBe(climb);
  expect(contourSlopeColor(-1, 0.55)).toBe(descent);
  expect(contourSlopeColor(0, 0.75, 1)).toBe('rgba(246, 182, 182, 0.75)');
  expect(contourSlopeColor(TERRAIN.TRAVEL_STEEP_GRADIENT, 0.55, 1)).toBe(descent);
  expect(contourSlopeColor(-TERRAIN.TRAVEL_STEEP_GRADIENT, 0.55, 1)).toBe(descent);
  expect(contourSlopeColor(TERRAIN.TRAVEL_STEEP_GRADIENT, 0.55, 0.5)).not.toBe(climb);
  expect(contourSlopeColor(0.0001, 0.55)).toBe(contourSlopeColor(-0.0001, 0.55));
  expect(contourSlopeColor(0.001, 0.55)).not.toBe(climb);
  expect(contourSlopeColor(0.00020001, 0.55)).toBe(contourSlopeColor(0, 0.55));
  // Further descent stays light. The ramp does not wrap back toward a climb.
  expect(contourSlopeColor(-2, 0.55)).toBe(descent);
});

test('cached gradients describe the height change at each contour', () => {
  const field = createHeightfield(TERRAIN.DEFAULT_SEED, { radius: 3100 });
  const segment = { ax: -2101, ay: 700, bx: -2099, by: 700 };
  const slope = contourSlope(segment, field);
  expect(slope.gradient.x).toBeGreaterThan(0);
  expect(sampleHeight(field, -2099, 700)).toBeGreaterThan(sampleHeight(field, -2101, 700));
  expect(contourSlope(segment, field)).toBe(slope);
});

test('every direction previews local climb along a straight route from the pilot', () => {
  const gradient = { x: 0.002, y: -0.001 };
  expect(radialSlope({ x: 200, y: 0 }, gradient)).toBeCloseTo(0.002);
  expect(radialSlope({ x: -200, y: 0 }, gradient)).toBeCloseTo(-0.002);
  expect(radialSlope({ x: 0, y: -200 }, gradient)).toBeCloseTo(0.001);
  expect(radialSlope({ x: 0, y: 200 }, gradient)).toBeCloseTo(-0.001);
  expect(radialSlope({ x: 100, y: 200 }, gradient)).toBeCloseTo(0);
  expect(radialSlope({ x: 0, y: 0 }, gradient)).toBe(0);
});

test('the 75-degree preview fades at its edges and excludes the sides and wake', () => {
  const heading = { x: 1, y: 0 };
  const at = (degrees: number) => ({
    x: Math.cos((degrees * Math.PI) / 180),
    y: Math.sin((degrees * Math.PI) / 180),
  });
  expect(previewConeWeight(at(0), heading)).toBe(1);
  expect(previewConeWeight(at(30), heading)).toBe(1);
  expect(previewConeWeight(at(35), heading)).toBeGreaterThan(0);
  expect(previewConeWeight(at(35), heading)).toBeLessThan(1);
  expect(previewConeWeight(at(38), heading)).toBe(0);
  expect(previewConeWeight(at(-38), heading)).toBe(0);
  expect(previewConeWeight(at(180), heading)).toBe(0);
});
