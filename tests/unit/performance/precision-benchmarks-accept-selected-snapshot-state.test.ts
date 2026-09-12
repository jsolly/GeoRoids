// @vitest-environment node
import { expect, test } from 'vitest';
import { assertSelectedSnapshotState } from '../../../benchmarks/snapshot-state';
import { snapshotFixture } from '../network/snapshotFixture';

test('benchmark validation rejects incomplete or incorrectly rounded worlds without changing the source', () => {
  const source = snapshotFixture(0);
  const asteroid = source.asteroids[0];
  const pilot = source.entities[0];
  expect(asteroid).toBeDefined();
  expect(pilot).toBeDefined();
  if (!asteroid || !pilot) {
    throw new Error('Missing declared fixture participants');
  }
  asteroid.position.x = 1.234567;
  pilot.position.x = 9.876543;
  const original = structuredClone(source);
  const selected = structuredClone(source);
  const selectedAsteroid = selected.asteroids[0];
  if (!selectedAsteroid) {
    throw new Error('Missing selected asteroid');
  }
  selectedAsteroid.position.x = 1.2346;
  expect(() => assertSelectedSnapshotState(selected, source)).not.toThrow();
  expect(() => assertSelectedSnapshotState(source, source)).toThrow('selected-precision state');

  const missing = structuredClone(selected);
  Reflect.deleteProperty(missing, 'playerProjectiles');
  expect(() => assertSelectedSnapshotState(missing, source)).toThrow('selected-precision state');
  const changedPilot = structuredClone(selected);
  const changed = changedPilot.entities[0];
  if (!changed) {
    throw new Error('Missing changed pilot');
  }
  changed.position.x = 9.8765;
  expect(() => assertSelectedSnapshotState(changedPilot, source)).toThrow(
    'selected-precision state'
  );
  expect(source).toEqual(original);
});
