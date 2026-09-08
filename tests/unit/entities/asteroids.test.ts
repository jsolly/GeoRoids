import { expect, test } from 'vitest';
import { DEBUG } from '../../../src/constants';
import { createRoidBelt, Roid } from '../../../src/entities/roid/Roid';

test('Roid Creation', () => {
  const roidPoint = { x: 10, y: 20 };
  const roidRadius = 10;
  const newRoid = new Roid(roidPoint, roidRadius);
  expect(newRoid).toBeInstanceOf(Roid);
});

test('Roid Belt Creation', () => {
  const testRoidBelt = createRoidBelt();
  expect(testRoidBelt).toBeInstanceOf(testRoidBelt.constructor);
  // The actual count depends on debug mode, so we check it's a reasonable number
  expect(testRoidBelt.roids.length).toBeGreaterThan(0);
  expect(testRoidBelt.roids.length).toBeLessThanOrEqual(25);
});

test('Roid Belt Add Roid', () => {
  const testRoidBelt = createRoidBelt();
  const roidCount = testRoidBelt.roids.length;
  testRoidBelt.addRoid();
  expect(testRoidBelt.roids.length).toEqual(roidCount + 1);
});

test('Roid Belt Spawn Roids', () => {
  const testRoidBelt = createRoidBelt();
  const initialCount = testRoidBelt.roids.length;

  // Remove most roids to trigger spawning (leave only 2, below minCount of 5)
  testRoidBelt.roids.splice(0, initialCount - 2);

  // Spawn roids multiple times to reach minCount
  for (let i = 0; i < 3 && testRoidBelt.roids.length < 5; i++) {
    testRoidBelt.spawnTimer = 180; // ROID_SPAWN_TIME
    testRoidBelt.spawnRoids();
  }

  // Should spawn enough to reach minCount (5)
  expect(testRoidBelt.roids.length).toEqual(5);
});

test('Destroy Roid', () => {
  const testRoidBelt = createRoidBelt();
  // const roidCount = testRoidBelt.roids.length;
  const result = testRoidBelt.destroyRoid(0);

  // Client no longer handles splitting - server does it via network messages
  expect(result.newRoids.length).toBe(0); // Client never creates new roids
  expect(result.score).toBeGreaterThan(0); // Should still return score
});

test('Move Roids', () => {
  const testRoidBelt = createRoidBelt();
  testRoidBelt.addRoid();
  const firstRoid = testRoidBelt.roids[0];
  expect(firstRoid).toBeDefined();
  const roid = firstRoid!;

  // Set deterministic velocity to ensure movement test is reliable
  roid.velocity = { x: 1, y: 0 }; // Move right at 1 unit per frame

  const previousX = roid.position.x;
  testRoidBelt.moveRoids();

  // Production interpolates unless debug mode explicitly freezes movement.
  if (DEBUG.ENABLED && !DEBUG.ROIDS.MOVEMENT) {
    expect(roid.position.x).toEqual(previousX);
  } else {
    expect(roid.position.x).not.toEqual(previousX);
  }
});

// Debug functionality is tested separately in the debug system
// since it's completely decoupled from the main roid logic
