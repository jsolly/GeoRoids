import { expect, test } from 'vitest';
import { chooseCrewSpawn } from '../../../shared/crewSpawn';
import { WORLD } from '../../../shared/world';

test('a requested pose inside the world is returned as a copy', () => {
  const previous = { x: 5_000, y: 1_000 };
  const spawned = chooseCrewSpawn({ previous, random: () => 0 });
  expect(spawned).toEqual(previous);
  expect(spawned).not.toBe(previous);
});

test('the first flight appears inside the region under the origin', () => {
  const spawned = chooseCrewSpawn({ random: () => 0.25 });
  expect(Math.hypot(spawned.x, spawned.y)).toBeLessThanOrEqual(WORLD.radius);
  expect(spawned.x).toBeGreaterThanOrEqual(0);
  expect(spawned.x).toBeLessThan(WORLD.sectorSize);
  expect(spawned.y).toBeGreaterThanOrEqual(0);
  expect(spawned.y).toBeLessThan(WORLD.sectorSize);
});

test('an in-world pose is kept while a living ally is elsewhere', () => {
  const previous = { x: 5_000, y: 1_000 };
  const spawned = chooseCrewSpawn({
    previous,
    allies: [{ x: -12_000, y: 4_000 }],
    random: () => 0.5,
  });
  expect(spawned).toEqual(previous);
  expect(spawned).not.toBe(previous);
});

test('a pose in the outer ring is kept instead of pulled to the spawn inset', () => {
  const previous = { x: WORLD.radius - 10, y: 0 };
  const spawned = chooseCrewSpawn({
    previous,
    allies: [{ x: 0, y: 0 }],
    random: () => 0.5,
  });
  expect(Math.hypot(previous.x, previous.y)).toBeGreaterThan(WORLD.radius - WORLD.spawnInset);
  expect(spawned).toEqual(previous);
});

test('a new pilot clusters off the first living ally', () => {
  const ally = { x: 8_000, y: -2_000 };
  const spawned = chooseCrewSpawn({
    previous: { x: WORLD.radius + 500, y: 0 },
    allies: [ally],
    random: () => 1,
  });
  expect(Math.hypot(spawned.x - ally.x, spawned.y - ally.y)).toBeCloseTo(WORLD.spawnClusterRadius);
});

test('a pilot clustering near the rim stays on the spawn inset', () => {
  const limit = WORLD.radius - WORLD.spawnInset;
  const ally = { x: limit, y: 0 };
  const spawned = chooseCrewSpawn({
    previous: { x: WORLD.radius + 500, y: 0 },
    allies: [ally],
    random: () => 0.01,
  });
  expect(Math.hypot(spawned.x, spawned.y)).toBeCloseTo(limit);
  expect(Math.hypot(spawned.x - ally.x, spawned.y - ally.y)).toBeLessThanOrEqual(
    0.01 * WORLD.spawnClusterRadius
  );
});
