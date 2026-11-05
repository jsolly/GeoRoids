import { expect, test } from 'vitest';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';
import { asteroidRow } from '../../support/asteroid-row';

test('a server-supplied asteroid advances once per client simulation step', () => {
  const belt = new RoidBelt();
  const roid = new Roid(asteroidRow({ x: 10, y: 20 }, 10, 'moving-asteroid'));
  roid.velocity = { x: 1, y: -2 };
  belt.add(roid);

  belt.moveRoids();

  expect(roid.position).toEqual({ x: 11, y: 18 });
  expect(roid.velocity).toEqual({ x: 1, y: -2 });
});
