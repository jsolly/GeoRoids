import { afterEach, expect, test } from 'vitest';
import { cruiseVelocity } from '../../../shared/shipFlight';
import { WORLD } from '../../../shared/world';
import { GAME } from '../../../src/constants';
import { advanceCruiseVelocity } from '../../../src/entities/ship/cruiseMotion';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { sampleGradient } from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import {
  isolineParallelBonus,
  terrainSpeedLimit,
} from '../../../src/physics/terrain/terrainTravel';

const position = { x: 2250, y: 0 };

afterEach(() => ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius }));

function tangentHeadings(gradient: { x: number; y: number }): [number, number] {
  const magnitude = Math.hypot(gradient.x, gradient.y);
  const tx = -gradient.y / magnitude;
  const ty = gradient.x / magnitude;
  return [Math.atan2(-ty, tx), Math.atan2(ty, -tx)];
}

function uphillComponent(gradient: { x: number; y: number }, angle: number): number {
  const heading = cruiseVelocity(angle, 1);
  return heading.x * gradient.x + heading.y * gradient.y;
}

function settledSpeed(angle: number, cruise: number, thrust: number): number {
  const ship = { position, angle, mass: 1, thrust, velocity: { x: 0, y: 0 } };
  for (let frame = 0; frame < 240; frame++) {
    advanceCruiseVelocity(ship, cruise);
  }
  return Math.hypot(ship.velocity.x, ship.velocity.y);
}

test('the parallel lane is half a Surveyor turn step, so the next step leaves it', () => {
  const step = (getShipKit('surveyor').turnSpeed * Math.PI) / (180 * GAME.FPS);
  expect(TERRAIN.ISOLINE_PARALLEL_TOLERANCE).toBeCloseTo(step / 2, 12);
  expect(getShipKit('hauler').turnSpeed).toBeLessThan(getShipKit('surveyor').turnSpeed);
});

test('a nose held on a steep isoline outruns an eight-degree downhill cut, and flat ground never qualifies', () => {
  const field = ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius });
  const gradient = sampleGradient(field, position.x, position.y);
  expect(Math.hypot(gradient.x, gradient.y)).toBeGreaterThan(0.002);
  const [forward, reverse] = tangentHeadings(gradient);
  const kit = getShipKit('surveyor');
  const cruise = kit.maxVelocity;
  const downhillSign = uphillComponent(gradient, forward + 0.01) < 0 ? 1 : -1;
  const eightDegrees = (8 * Math.PI) / 180;
  const downhillCut = forward + downhillSign * eightDegrees;
  const justOutside = forward + downhillSign * (TERRAIN.ISOLINE_PARALLEL_TOLERANCE + 0.01);
  const onEdge = forward + downhillSign * TERRAIN.ISOLINE_PARALLEL_TOLERANCE;

  expect(uphillComponent(gradient, downhillCut)).toBeLessThan(0);
  expect(isolineParallelBonus(position, forward)).toBeGreaterThan(
    TERRAIN.ISOLINE_PARALLEL_BONUS * 0.6
  );
  expect(isolineParallelBonus(position, reverse)).toBeGreaterThan(0);
  expect(isolineParallelBonus(position, onEdge)).toBeGreaterThan(0);
  expect(isolineParallelBonus(position, justOutside)).toBe(0);
  expect(isolineParallelBonus(position, downhillCut)).toBe(0);
  expect(isolineParallelBonus(position, Math.atan2(-gradient.y, gradient.x))).toBe(0);

  const parallel = settledSpeed(forward, cruise, kit.thrust);
  const reverseSpeed = settledSpeed(reverse, cruise, kit.thrust);
  const cut = settledSpeed(downhillCut, cruise, kit.thrust);
  const outside = settledSpeed(justOutside, cruise, kit.thrust);
  expect(parallel).toBeGreaterThan(cut);
  expect(parallel).toBeGreaterThan(outside);
  expect(reverseSpeed).toBeGreaterThan(cruise * (1 + TERRAIN.ISOLINE_PARALLEL_BONUS * 0.6));
  expect(parallel).toBeLessThanOrEqual(terrainSpeedLimit(position, cruise) + 1e-9);
  expect(reverseSpeed).toBeLessThanOrEqual(terrainSpeedLimit(position, cruise) + 1e-9);

  for (let angle = 0; angle < Math.PI * 2; angle += 0.4) {
    expect(isolineParallelBonus({ x: 0, y: 0 }, angle)).toBe(0);
  }
});
