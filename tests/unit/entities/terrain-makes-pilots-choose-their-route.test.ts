import { afterEach, expect, test } from 'vitest';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { WORLD } from '../../../shared/world';
import {
  advanceCruiseVelocity,
  contourSpeedStrength,
} from '../../../src/entities/ship/cruiseMotion';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { sampleGradient } from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import {
  terrainCruiseVelocity,
  terrainSpeedLimit,
} from '../../../src/physics/terrain/terrainTravel';

const position = { x: -2100, y: 700 };
const bounds = { cx: 0, cy: 0, radius: WORLD.radius };
afterEach(() => ensureTerrain(TERRAIN.DEFAULT_SEED, bounds));

test.each(['scout', 'hauler'] as const)(
  '%s follows contours equally fast in either direction and crosses at ordinary cruise at any mass',
  (kitId) => {
    const field = ensureTerrain(TERRAIN.DEFAULT_SEED, bounds);
    const gradient = sampleGradient(field, position.x, position.y);
    expect(Math.hypot(gradient.x, gradient.y)).toBeGreaterThan(0.002);
    const across = Math.atan2(-gradient.y, gradient.x);
    const kit = getShipKit(kitId);
    for (const mass of [1, 8]) {
      const cruise = cruiseSpeed(mass, kit.maxVelocity);
      const speeds = [across, across + Math.PI, across + Math.PI / 2, across - Math.PI / 2].map(
        (angle) => {
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
          // Motion follows the nose, without lateral terrain drift.
          expect(ship.velocity.x * Math.sin(angle) + ship.velocity.y * Math.cos(angle)).toBeCloseTo(
            0,
            10
          );
          return Math.hypot(ship.velocity.x, ship.velocity.y);
        }
      );
      expect(speeds[0]).toBeCloseTo(cruise, 10);
      expect(speeds[1]).toBeCloseTo(cruise, 10);
      expect(speeds[2]).toBeGreaterThan(cruise * 1.9);
      expect(speeds[3]).toBeCloseTo(speeds[2] ?? 0, 10);
      expect(speeds[2]).toBeCloseTo(terrainSpeedLimit(position, cruise), 10);
    }
  }
);

test('turning across a current sheds the bonus gently without a speed debt', () => {
  const field = ensureTerrain(TERRAIN.DEFAULT_SEED, bounds);
  const gradient = sampleGradient(field, position.x, position.y);
  const across = Math.atan2(-gradient.y, gradient.x);
  const kit = getShipKit('scout');
  const ship = {
    position,
    angle: across + Math.PI / 2,
    mass: 1,
    thrust: kit.thrust,
    velocity: { x: 0, y: 0 },
  };
  for (let frame = 0; frame < 180; frame++) {
    advanceCruiseVelocity(ship, kit.maxVelocity);
  }
  expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeGreaterThan(kit.maxVelocity * 1.9);
  ship.angle = across;
  const before = Math.hypot(ship.velocity.x, ship.velocity.y);
  advanceCruiseVelocity(ship, kit.maxVelocity);
  expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeGreaterThan(kit.maxVelocity);
  expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeLessThan(before);
  let previous = before;
  for (let frame = 0; frame < 22; frame++) {
    advanceCruiseVelocity(ship, kit.maxVelocity);
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    expect(speed).toBeLessThanOrEqual(previous + 1e-10);
    expect(speed).toBeGreaterThanOrEqual(kit.maxVelocity - 1e-10);
    previous = speed;
  }
  expect(previous).toBeCloseTo(kit.maxVelocity, 10);
});

test('flat spawn preserves normal cruise and every current heading stays between cruise and its ceiling', () => {
  ensureTerrain(TERRAIN.DEFAULT_SEED, bounds);
  const cruise = getShipKit('scout').maxVelocity;
  expect(terrainSpeedLimit({ x: 0, y: 0 }, cruise)).toBe(cruise);
  for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
    const flat = terrainCruiseVelocity({ x: 0, y: 0 }, angle, cruise);
    expect(Math.hypot(flat.x, flat.y)).toBeCloseTo(cruise, 10);
    const velocity = terrainCruiseVelocity(position, angle, cruise);
    expect(Math.hypot(velocity.x, velocity.y)).toBeGreaterThanOrEqual(cruise - 1e-9);
    expect(Math.hypot(velocity.x, velocity.y)).toBeLessThanOrEqual(
      terrainSpeedLimit(position, cruise) + 1e-9
    );
    const reversed = terrainCruiseVelocity(position, angle + Math.PI, cruise);
    expect(reversed.x).toBeCloseTo(-velocity.x, 10);
    expect(reversed.y).toBeCloseTo(-velocity.y, 10);
  }
});

test('a blast retains the same velocity on dense contours as on flat ground without terrain tug', () => {
  ensureTerrain(TERRAIN.DEFAULT_SEED, bounds);
  const ships = [{ x: 0, y: 0 }, position].map((start) => {
    const ship = new Ship({ position: { ...start }, isLocalPlayer: true });
    ship.velocity = { x: 0, y: 12 };
    ship.knockbackVelocityLimit = 12;
    ship.angle = 0;
    ship.thrusting = true;
    ship.update();
    return ship;
  });
  expect(ships[1]?.velocity).toEqual(ships[0]?.velocity);
  expect(ships[1]?.velocity.y).toBeGreaterThan(4);
});

test('diagonal travel earns half the parallel bonus and empty space has no penalty', () => {
  const field = ensureTerrain(TERRAIN.DEFAULT_SEED, bounds);
  const gradient = sampleGradient(field, position.x, position.y);
  const across = Math.atan2(-gradient.y, gradient.x);
  const speedAt = (angle: number) => {
    const velocity = terrainCruiseVelocity(position, angle, 1);
    return Math.hypot(velocity.x, velocity.y);
  };
  expect(speedAt(across + Math.PI / 4) - 1).toBeCloseTo(
    (speedAt(across + Math.PI / 2) - 1) / 2,
    10
  );
  for (const empty of [
    { x: 0, y: 0 },
    { x: WORLD.radius + 100, y: 0 },
  ]) {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.2) {
      const velocity = terrainCruiseVelocity(empty, angle, 1);
      expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(1, 10);
    }
  }
});

test.each(['scout', 'hauler'] as const)(
  '%s speed lines reflect terrain speed rather than blasts',
  (kitId) => {
    const ship = new Ship({ position: { x: 0, y: 0 }, isLocalPlayer: true, kitId });
    const baseline = cruiseSpeed(ship.mass, ship.maxVelocity);
    for (const bonus of [0, 0.5, 1]) {
      ship.velocity = { x: baseline * (1 + TERRAIN.CONTOUR_SPEED_BONUS * bonus), y: 0 };
      expect(contourSpeedStrength(ship)).toBeCloseTo(bonus, 10);
    }
    ship.knockbackVelocityLimit = baseline * 3;
    expect(contourSpeedStrength(ship)).toBe(0);
  }
);
