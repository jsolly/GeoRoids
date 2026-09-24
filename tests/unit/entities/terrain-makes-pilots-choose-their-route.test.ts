import { afterEach, expect, test } from 'vitest';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { WORLD } from '../../../shared/world';
import { advanceCruiseVelocity } from '../../../src/entities/ship/cruiseMotion';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { sampleGradient } from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import {
  terrainCruiseVelocity,
  terrainSpeedLimit,
} from '../../../src/physics/terrain/terrainTravel';

const position = { x: -2100, y: 700 };
afterEach(() => ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius }));

test.each(['scout', 'hauler'] as const)(
  '%s can climb steep contours at any mass without boost, but descents are much faster',
  (kitId) => {
    const field = ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius });
    const gradient = sampleGradient(field, position.x, position.y);
    expect(Math.hypot(gradient.x, gradient.y)).toBeGreaterThan(0.002);
    const uphill = Math.atan2(-gradient.y, gradient.x);
    const kit = getShipKit(kitId);
    for (const mass of [1, 8]) {
      const cruise = cruiseSpeed(mass, kit.maxVelocity);
      const speeds = [uphill, uphill + Math.PI].map((angle) => {
        const ship: Parameters<typeof advanceCruiseVelocity>[0] = {
          position,
          angle,
          mass,
          thrust: kit.thrust,
          velocity: { x: 0, y: 0 },
        };
        for (let frame = 0; frame < 300; frame++) {
          advanceCruiseVelocity(ship, cruise);
        }
        return Math.hypot(ship.velocity.x, ship.velocity.y);
      });
      const [climb = 0, descent = 0] = speeds;
      expect(TERRAIN.CLIMB_SPEED_FRACTION).toBe(0.7);
      expect(TERRAIN.DESCENT_SPEED_BONUS).toBe(1.15);
      expect(climb).toBeGreaterThanOrEqual(cruise * 0.65);
      expect(climb).toBeLessThan(cruise * 0.82);
      expect(descent).toBeGreaterThan(cruise * 1.9);
      expect(descent).toBeGreaterThan(climb * 2.5);
      expect(descent).toBeLessThanOrEqual(terrainSpeedLimit(position, cruise) + 1e-9);
    }
  }
);

test('crossing a steep hillside keeps nearly full cruise with a light downhill tug', () => {
  const field = ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius });
  const gradient = sampleGradient(field, position.x, position.y);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  const uphill = Math.atan2(-gradient.y, gradient.x);
  const kit = getShipKit('scout');
  const ship: Parameters<typeof advanceCruiseVelocity>[0] = {
    position,
    angle: uphill + Math.PI / 2,
    mass: 1,
    thrust: kit.thrust,
    velocity: { x: 0, y: 0 },
  };
  for (let frame = 0; frame < 180; frame++) {
    advanceCruiseVelocity(ship, kit.maxVelocity);
  }
  const downhillDrift = -(ship.velocity.x * gradient.x + ship.velocity.y * gradient.y) / magnitude;
  expect(TERRAIN.CROSS_SLOPE_DRIFT).toBe(0.16);
  expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeGreaterThan(kit.maxVelocity * 0.98);
  expect(downhillDrift).toBeGreaterThan(kit.maxVelocity * 0.1);
  expect(downhillDrift).toBeLessThan(kit.maxVelocity * 0.22);
  const before = { ...ship.velocity };
  advanceCruiseVelocity(ship, kit.maxVelocity);
  expect(ship.velocity).toEqual(before);
});

test('flat starter terrain preserves the normal cap and steep descents have a bounded ceiling for every heading', () => {
  ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius });
  const cruise = getShipKit('scout').maxVelocity;
  expect(terrainSpeedLimit({ x: 0, y: 0 }, cruise)).toBe(cruise);
  for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
    const velocity = terrainCruiseVelocity(position, angle, cruise);
    expect(Math.hypot(velocity.x, velocity.y)).toBeLessThanOrEqual(
      terrainSpeedLimit(position, cruise) + 1e-9
    );
  }
});
