import { afterEach, expect, test, vi } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';

afterEach(() => {
  vi.restoreAllMocks();
});

test('a pilot fires on cooldown and cannot exceed the active laser limit', () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const ship = new Ship({ isLocalPlayer: true });

  ship.shoot();
  expect(ship.lasers).toHaveLength(1);
  now += ship.shotCooldown - 1;
  ship.shoot();
  expect(ship.lasers).toHaveLength(1);
  now++;
  ship.shoot();
  expect(ship.lasers).toHaveLength(2);

  for (let count = 2; count < SHIP.MAX_LASERS; count++) {
    now += ship.shotCooldown;
    ship.shoot();
  }
  expect(ship.lasers).toHaveLength(SHIP.MAX_LASERS);
  now += ship.shotCooldown;
  ship.shoot();
  expect(ship.lasers).toHaveLength(SHIP.MAX_LASERS);
});
