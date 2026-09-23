import { expect, test } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  applyShipKitToShip,
  DEFAULT_SHIP_KIT_ID,
  getShipKit,
  HAULER_TO_SCOUT_SIZE,
  hullRadiusForKit,
  listShipKits,
  parseShipKitId,
  SHIP_KIT_IDS,
} from '../../../src/entities/ship/shipKits';

test('pilots choose exactly Scout or Hauler and retired selections fall back to Scout', () => {
  expect(SHIP_KIT_IDS).toEqual(['scout', 'hauler']);
  expect(listShipKits().map((kit) => kit.name)).toEqual(['Scout', 'Hauler']);
  expect(DEFAULT_SHIP_KIT_ID).toBe('scout');
  for (const retired of ['dart', 'warden', 'skirmisher', 'quake', undefined]) {
    expect(parseShipKitId(retired)).toBe('scout');
  }
});

test('Scout handles more nimbly while Hauler keeps its heavy hull at the same cruise speed', () => {
  const scout = getShipKit('scout'),
    hauler = getShipKit('hauler');
  expect(scout.turnSpeed).toBe(540);
  expect(scout.turnSpeed).toBeGreaterThan(hauler.turnSpeed);
  expect(scout.size).toBeLessThan(hauler.size);
  expect(scout.maxVelocity).toBe(SHIP.MAX_VELOCITY);
  expect(hauler.maxVelocity).toBe(scout.maxVelocity);
  expect(scout.boostMultiplier).toBeGreaterThan(hauler.boostMultiplier);
  expect(hauler.maxHealth).toBeGreaterThan(scout.maxHealth);
  expect(scout.abilityId).toBe('surveyScan');
  expect(hauler.abilityId).toBe('harpoon');
});

test('Hauler is about twice Scout on the playfield, including collision radius', () => {
  const scout = getShipKit('scout');
  const hauler = getShipKit('hauler');
  const ratio = hauler.size / scout.size;
  expect(scout.size).toBe(SHIP.SIZE);
  expect(hauler.size).toBe(SHIP.SIZE * HAULER_TO_SCOUT_SIZE);
  expect(ratio).toBeGreaterThanOrEqual(1.8);
  expect(ratio).toBeLessThanOrEqual(2.2);
  expect(hullRadiusForKit('hauler')).toBe(hauler.size / 2);
  expect(hullRadiusForKit('scout')).toBe(scout.size / 2);
  expect(hullRadiusForKit('hauler') / hullRadiusForKit('scout')).toBe(ratio);
});

test('a spawned Hauler ship uses the barge hull instead of the Scout hull', () => {
  const hauler = new Ship({ kitId: 'hauler' });
  const scout = new Ship({ kitId: 'scout' });
  expect(hauler.r).toBe(hullRadiusForKit('hauler'));
  expect(scout.r).toBe(hullRadiusForKit('scout'));
  expect(hauler.r).toBeGreaterThan(scout.r * 1.8);
  expect(hauler.r).toBeLessThanOrEqual(scout.r * 2.2);
});

test('every ship uses the same two kit definitions', () => {
  const ship = new Ship({ kitId: 'hauler' });
  expect(ship.maxHealth).toBe(140);
  applyShipKitToShip(ship, 'scout');
  expect(ship.kitId).toBe('scout');
  expect(ship.turnSpeed).toBe(540);
  expect(ship.maxHealth).toBe(100);
});
