import { expect, test } from 'vitest';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';
import { asteroidRow } from '../../support/asteroid-row';

const rock = (id: string, x = 0) => new Roid(asteroidRow({ x, y: 0 }, 10, id));

/**
 * The belt owns every membership change, so `getById` cannot disagree with the
 * belt. An earlier revision kept `roids` public and rebuilt the index when the
 * array's identity or length stopped matching what was indexed; these cases
 * drive the sequences that watching an array cannot see.
 */
test('a removal and an addition that keep the length do not strand the index', () => {
  const belt = new RoidBelt();
  const ice = rock('ice', 10);
  belt.add(ice);
  belt.add(rock('metal', 20));
  expect(belt.getById('ice')).toBe(ice);

  // The sequence the old identity-and-length guard could not detect: one rock
  // leaves and one arrives between two lookups, so the array is the same object
  // at the same length and looks untouched. Snapshots fan created before
  // removed, so this is ordinary traffic rather than a contrived order.
  expect(belt.remove(ice)).toBe(true);
  const arrival = rock('crystal', 30);
  belt.add(arrival);
  expect(belt.size()).toBe(2);

  // The departed rock must be gone -- stranding it applies a snapshot row to a
  // rock no longer in the belt -- and the arrival must be found, or its
  // kinematics never apply and its destroy event is dropped.
  expect(belt.getById('ice')).toBeUndefined();
  expect(belt.getById('crystal')).toBe(arrival);
});

test('a sustained one-in, one-out belt keeps answering for every live rock', () => {
  const belt = new RoidBelt();
  for (const id of ['a', 'b', 'c', 'd']) {
    belt.add(rock(id));
  }

  // Twelve ticks of a rock leaving as a rock arrives. The old guard re-armed its
  // stale window on every tick, so a single pass is not enough to catch it.
  let departing = 'a';
  for (let tick = 0; tick < 12; tick += 1) {
    const leaving = belt.getById(departing);
    expect(leaving, `tick ${tick} lost ${departing}`).toBeDefined();
    if (leaving) {
      expect(belt.remove(leaving)).toBe(true);
    }
    const arrivingId = `arrival-${tick}`;
    belt.add(rock(arrivingId));
    expect(belt.getById(arrivingId)?.id, `tick ${tick} could not find ${arrivingId}`).toBe(
      arrivingId
    );
    expect(belt.getById(departing), `tick ${tick} stranded ${departing}`).toBeUndefined();
    expect(belt.size()).toBe(4);
    departing = arrivingId;
  }
});

test('the belt answers for what it holds, and only that', () => {
  const belt = new RoidBelt();
  belt.add(rock('ice', 10));
  belt.add(rock('metal', 20));
  expect(belt.getById('metal')?.id).toBe('metal');
  expect(belt.getById('absent')).toBeUndefined();
  expect(belt.getById('ice')).toBe(belt.getById('ice'));

  // Removing a rock the belt never held changes nothing.
  expect(belt.remove(rock('stranger', 99))).toBe(false);
  expect(belt.size()).toBe(2);

  // Replaced wholesale, as a join or a display-rate scenario does. Same length
  // as the previous contents, so only the array's identity reveals the change.
  const crystal = rock('crystal', 30);
  belt.replaceAll([crystal, rock('rubble', 40)]);
  expect(belt.getById('ice')).toBeUndefined();
  expect(belt.getById('metal')).toBeUndefined();
  expect(belt.getById('crystal')).toBe(crystal);

  // A fresh rock reusing a retired id resolves to the live object.
  const replacement = rock('crystal', 99);
  belt.replaceAll([replacement]);
  expect(belt.getById('crystal')).toBe(replacement);

  // Emptied, as the clock scenario does.
  belt.replaceAll([]);
  expect(belt.getById('crystal')).toBeUndefined();
  expect(belt.size()).toBe(0);

  // Grown again afterwards.
  belt.add(rock('rubble', 40));
  expect(belt.getById('rubble')?.id).toBe('rubble');
});
