import { expect, test } from 'vitest';
import {
  FURNACES,
  isTownSquareArrival,
  TOWN_HEARTH,
  TOWN_SPAWN_RADIUS,
  townSquareSpawn,
} from '../../../shared/furnaces';

test('Town Square is the only hearth and sits on the origin', () => {
  expect(FURNACES).toEqual([TOWN_HEARTH]);
  expect(TOWN_HEARTH.position).toEqual({ x: 0, y: 0 });
  expect(TOWN_HEARTH.radius).toBe(85);
});

test('fresh flights stand on the town ring', () => {
  for (let index = 0; index < 20; index++) {
    const position = townSquareSpawn(() => index / 20);
    expect(Math.hypot(position.x, position.y)).toBeCloseTo(TOWN_SPAWN_RADIUS, 5);
    expect(isTownSquareArrival(position)).toBe(true);
  }
  expect(isTownSquareArrival({ x: 8_000, y: 0 })).toBe(false);
});
