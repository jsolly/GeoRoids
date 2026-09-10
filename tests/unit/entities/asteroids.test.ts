import { expect, test } from 'vitest';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';

test('a server-supplied asteroid advances by the elapsed client frames', () => {
  const belt = new RoidBelt();
  const roid = new Roid({ x: 10, y: 20 }, 10, 'moving-asteroid');
  roid.velocity = { x: 1, y: -2 };
  belt.roids.push(roid);

  belt.moveRoids(2);

  expect(roid.position).toEqual({ x: 12, y: 16 });
  expect(roid.velocity).toEqual({ x: 1, y: -2 });
});
