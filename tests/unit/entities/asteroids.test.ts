import { expect, test, vi } from 'vitest';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';

vi.mock('../../../src/constants', async (importOriginal) => {
  const constants = await importOriginal<typeof import('../../../src/constants')>();
  return { ...constants, DEBUG: { ...constants.DEBUG, ENABLED: false } };
});

test('a server-supplied asteroid advances once per client simulation step', () => {
  const belt = new RoidBelt();
  const roid = new Roid({ x: 10, y: 20 }, 10, 'moving-asteroid');
  roid.velocity = { x: 1, y: -2 };
  belt.roids.push(roid);

  belt.moveRoids();

  expect(roid.position).toEqual({ x: 11, y: 18 });
  expect(roid.velocity).toEqual({ x: 1, y: -2 });
});
