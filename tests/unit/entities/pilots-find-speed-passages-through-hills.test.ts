import { expect, test } from 'vitest';
import { sampleContourHeight, sampleGradient } from '../../../src/physics/terrain/heightfield';
import {
  passageAlignment,
  passageStrength,
  samplePassages,
} from '../../../src/physics/terrain/passages';
import { applySlopeForce } from '../../../src/physics/terrain/slopeForce';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import {
  terrainCruiseVelocity,
  terrainSpeedLimit,
} from '../../../src/physics/terrain/terrainTravel';

const field = () => ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 60000 });

function center() {
  const terrain = field();
  for (let x = 1500; x < 4000; x += 71) {
    for (let y = 0; y < 1100; y++) {
      const [route, crossing] = samplePassages(terrain, x, y);
      if (route.strength > 0.999 && crossing.strength === 0) {
        return { position: { x, y }, angle: Math.atan2(-route.tangentY, route.tangentX) };
      }
    }
  }
  throw new Error('No passage center found');
}

test('pilots gain half a cruise speed in either direction but lose it when crossing the cut', () => {
  const { position, angle } = center();
  const terrain = field();
  for (const heading of [angle, angle + Math.PI]) {
    expect(passageAlignment(terrain, position.x, position.y, heading)).toBeGreaterThan(0.999);
    const velocity = terrainCruiseVelocity(position, heading, 1);
    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(1.5, 2);
  }
  expect(passageAlignment(terrain, position.x, position.y, angle + Math.PI / 4)).toBeCloseTo(
    0.25,
    3
  );
  expect(passageAlignment(terrain, position.x, position.y, angle + Math.PI / 2)).toBeLessThan(
    1e-10
  );
  const crossing = terrainCruiseVelocity(position, angle + Math.PI / 2, 1);
  expect(Math.hypot(crossing.x, crossing.y)).toBeCloseTo(1, 2);
  const outside = samplePassages(terrain, position.x, position.y + 200);
  expect(outside.every((route) => route.strength === 0)).toBe(true);
});

test('narrow cuts visibly pull contours toward a level pass and preserve ordinary spawn', () => {
  const { position } = center();
  const terrain = field();
  const centerHeight = Math.abs(sampleContourHeight(terrain, position.x, position.y));
  const banks = [-150, 150].map((offset) =>
    Math.abs(sampleContourHeight(terrain, position.x, position.y + offset))
  );
  expect(Math.max(...banks)).toBeGreaterThan(centerHeight * 2);
  expect(samplePassages(terrain, 0, 0).every((route) => route.strength === 0)).toBe(true);
  expect(terrainCruiseVelocity({ x: 0, y: 0 }, 0, 1)).toEqual({ x: 1, y: 0 });
});

test('an easy passage does not pull a pilot down into a basin', () => {
  const { position } = center();
  const terrain = field();
  const velocity = { x: 4, y: -2 };
  applySlopeForce(velocity, position, terrain, 1);
  expect(velocity).toEqual({ x: 4, y: -2 });
});

test('a partial passage keeps only the open share of the downhill pull', () => {
  const terrain = field();
  for (let x = 900; x < 5000; x += 35) {
    for (let y = -2000; y < 4000; y += 41) {
      const strength = passageStrength(terrain, x, y);
      if (strength < 0.25 || strength > 0.75) {
        continue;
      }
      const gradient = sampleGradient(terrain, x, y);
      const steepness = Math.hypot(gradient.x, gradient.y);
      if (steepness < TERRAIN.TRAVEL_STEEP_GRADIENT) {
        continue;
      }
      const open = 1 - strength;
      const scale = Math.min(1, steepness / TERRAIN.REF_GRADIENT);
      const accel = TERRAIN.SLOPE_ACCEL * scale * open;
      const velocity = { x: 0, y: 0 };
      applySlopeForce(velocity, { x, y }, terrain, 1);
      expect(velocity.x).toBeCloseTo((-gradient.x / steepness) * accel, 5);
      expect(velocity.y).toBeCloseTo((-gradient.y / steepness) * accel, 5);
      expect(Math.hypot(velocity.x, velocity.y)).toBeGreaterThan(0.2);
      const nx = gradient.x / steepness;
      const ny = gradient.y / steepness;
      const climbing = { x: nx * 8, y: ny * 8 };
      applySlopeForce(climbing, { x, y }, terrain, 1);
      const pulledX = nx * 8 - nx * accel;
      const pulledY = ny * 8 - ny * accel;
      const uphillAfter = pulledX * nx + pulledY * ny;
      const drag = TERRAIN.UPHILL_DRAG * scale * uphillAfter * open;
      expect(uphillAfter).toBeGreaterThan(0);
      expect(climbing.x).toBeCloseTo(pulledX - nx * drag, 5);
      expect(climbing.y).toBeCloseTo(pulledY - ny * drag, 5);
      return;
    }
  }
  throw new Error('No partial passage on a real slope');
});

test('one easy passage joins the crossing easy passage', () => {
  const terrain = field();
  for (let x = 800; x < 6000; x += 23) {
    for (let y = 800; y < 6000; y += 29) {
      const routes = samplePassages(terrain, x, y);
      if (routes.some((route) => route.strength < 0.85)) {
        continue;
      }
      for (const route of routes) {
        const angle = Math.atan2(-route.tangentY, route.tangentX);
        for (const heading of [angle, angle + Math.PI]) {
          expect(passageAlignment(terrain, x, y, heading)).toBeGreaterThan(0.85);
          const velocity = terrainCruiseVelocity({ x, y }, heading, 1);
          expect(Math.hypot(velocity.x, velocity.y)).toBeGreaterThan(1.4);
        }
      }
      return;
    }
  }
  throw new Error('No joined easy passages');
});

test('intersections never stack speed bonuses and every heading stays within the server ceiling', () => {
  const terrain = field();
  let intersections = 0;
  for (let x = 800; x < 4000; x += 37) {
    for (let y = 800; y < 4000; y += 41) {
      const routes = samplePassages(terrain, x, y);
      if (routes.every((route) => route.strength > 0.2)) {
        intersections++;
      }
      for (const angle of [0, 0.7, 1.8, 3.9, 5.2]) {
        expect(passageAlignment(terrain, x, y, angle)).toBeLessThanOrEqual(1);
        const velocity = terrainCruiseVelocity({ x, y }, angle, 1);
        expect(Math.hypot(velocity.x, velocity.y)).toBeLessThanOrEqual(
          terrainSpeedLimit({ x, y }, 1) + 1e-9
        );
      }
    }
  }
  expect(intersections).toBeGreaterThan(5);
});
