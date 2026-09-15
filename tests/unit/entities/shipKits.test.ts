import { expect, test } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  applyShipKitToShip,
  DEFAULT_SHIP_KIT_ID,
  getShipKit,
  listShipKits,
  parseShipKitId,
  SHIP_KIT_IDS,
} from '../../../src/entities/ship/shipKits';

test('pilots choose exactly Surveyor or Hauler and retired selections fall back to Surveyor', () => {
  expect(SHIP_KIT_IDS).toEqual(['surveyor', 'hauler']);
  expect(listShipKits().map((kit) => kit.name)).toEqual(['Surveyor', 'Hauler']);
  expect(DEFAULT_SHIP_KIT_ID).toBe('surveyor');
  for (const retired of ['dart', 'warden', 'skirmisher', 'quake', undefined]) {
    expect(parseShipKitId(retired)).toBe('surveyor');
  }
});

test('Surveyor handles more nimbly while Hauler keeps its heavy hull at the same cruise speed', () => {
  const surveyor = getShipKit('surveyor'),
    hauler = getShipKit('hauler');
  expect(surveyor.turnSpeed).toBe(540);
  expect(surveyor.turnSpeed).toBeGreaterThan(hauler.turnSpeed);
  expect(surveyor.size).toBeLessThan(hauler.size);
  expect(surveyor.maxVelocity).toBe(SHIP.MAX_VELOCITY);
  expect(hauler.maxVelocity).toBe(surveyor.maxVelocity);
  expect(surveyor.boostMultiplier).toBeGreaterThan(hauler.boostMultiplier);
  expect(hauler.maxHealth).toBeGreaterThan(surveyor.maxHealth);
  expect(surveyor.abilityId).toBe('surveyScan');
  expect(hauler.abilityId).toBe('harpoon');
});

test('every ship uses the same two kit definitions', () => {
  const ship = new Ship({ kitId: 'hauler' });
  expect(ship.maxHealth).toBe(140);
  applyShipKitToShip(ship, 'surveyor');
  expect(ship.kitId).toBe('surveyor');
  expect(ship.turnSpeed).toBe(540);
  expect(ship.maxHealth).toBe(100);
});
