import { expect, test } from 'vitest';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';
import { asteroidRow } from '../../support/asteroid-row';

const rock = (id: string, x = 0) => new Roid(asteroidRow({ x, y: 0 }, 10, id));

/**
 * `RoidBelt.roids` is a plain public array, and callers across the client, the
 * tests and the benchmark harness push, splice, truncate and replace it
 * directly. The id index behind `getById` must follow every one of those, or a
 * snapshot row would silently stop applying to its rock.
 */
test('the belt finds rocks by id after callers edit the array behind it', () => {
  const belt = new RoidBelt();

  // Pushed directly, as gameController and the benchmark harness do.
  belt.roids.push(rock('ice', 10), rock('metal', 20));
  expect(belt.getById('ice')?.id).toBe('ice');
  expect(belt.getById('metal')?.id).toBe('metal');
  expect(belt.getById('absent')).toBeUndefined();

  // Repeated lookups keep answering from the same belt contents.
  expect(belt.getById('ice')).toBe(belt.getById('ice'));

  // Spliced directly, as the destroy path does.
  belt.roids.splice(0, 1);
  expect(belt.getById('ice')).toBeUndefined();
  expect(belt.getById('metal')?.id).toBe('metal');

  // Replaced wholesale, as the display-rate scenarios do. Same length as the
  // previous contents, so only the array's identity reveals the change.
  belt.roids = [rock('crystal', 30)];
  expect(belt.getById('metal')).toBeUndefined();
  expect(belt.getById('crystal')?.id).toBe('crystal');

  // A fresh rock reusing a retired id resolves to the live object.
  const replacement = rock('crystal', 99);
  belt.roids = [replacement];
  expect(belt.getById('crystal')).toBe(replacement);

  // Truncated in place, as the clock scenario does.
  belt.roids.length = 0;
  expect(belt.getById('crystal')).toBeUndefined();

  // Grown again after truncation.
  belt.roids.push(rock('rubble', 40));
  expect(belt.getById('rubble')?.id).toBe('rubble');
});
