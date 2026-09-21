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

test('a lone returning pilot clusters near the first living ally', () => {
  const ally = { x: 8_000, y: -2_000 };
  const spawned = chooseCrewSpawn({
    previous: { x: WORLD.radius + 500, y: 0 },
    allies: [ally],
    random: () => 0,
  });
  expect(Math.hypot(spawned.x - ally.x, spawned.y - ally.y)).toBeLessThanOrEqual(
    WORLD.spawnClusterRadius + 1e-6
  );
});
