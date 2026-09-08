import { expect, test } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  AD_V2_HULL_BAKE_LOCKED,
  AD_V2_HULL_SHEET,
  AD_V2_HULL_TOPOLOGY,
  applyShipKitToShip,
  DEFAULT_SHIP_KIT_ID,
  getShipKit,
  HAULER_TETHER_COLOR,
  HAULER_TETHER_TIP_COLOR,
  KIT_HULLS_ARE_PLACEHOLDERS,
  listShipKits,
  SHIP_KIT_IDS,
} from '../../../src/entities/ship/shipKits';

test('kit roster is Dart / Hauler / Warden / Skirmisher / Quake', () => {
  expect(SHIP_KIT_IDS).toEqual(['dart', 'hauler', 'warden', 'skirmisher', 'quake']);
  expect(SHIP_KIT_IDS).toHaveLength(5);
  expect(listShipKits().map((kit) => kit.name)).toEqual([
    'Dart',
    'Hauler',
    'Warden',
    'Skirmisher',
    'Quake',
  ]);
  expect(listShipKits().some((kit) => kit.name === 'Surveyor')).toBe(false);
  expect(listShipKits().some((kit) => kit.name === 'Hook')).toBe(false);
  expect((SHIP_KIT_IDS as readonly string[]).includes('hook')).toBe(false);
});

test('harpoon is Hauler-only and is not a sixth kit', () => {
  const harpoonKits = listShipKits().filter((kit) => kit.abilityId === 'harpoon');
  expect(harpoonKits.map((kit) => kit.id)).toEqual(['hauler']);
  expect(getShipKit('hauler').abilityName).toBe('Harpoon');
  expect(listShipKits().some((kit) => String(kit.abilityId) === 'lootMagnet')).toBe(false);
  expect(HAULER_TETHER_COLOR).toBe('#E8D5A3');
  expect(HAULER_TETHER_TIP_COLOR).toBe('#FDE68A');
});

test('Dart keeps classic ship numbers so existing play stays familiar', () => {
  expect(DEFAULT_SHIP_KIT_ID).toBe('dart');
  const dart = getShipKit('dart');
  expect(dart.maxHealth).toBe(SHIP.MAX_HEALTH);
  expect(dart.size).toBe(SHIP.SIZE);
  expect(dart.turnSpeed).toBe(SHIP.TURN_SPEED);
  const ship = new Ship();
  expect(ship.kitId).toBe('dart');
  expect(ship.maxHealth).toBe(SHIP.MAX_HEALTH);
  expect(ship.turnSpeed).toBe(SHIP.TURN_SPEED);
});

test('kit abilities are mixed flavors and geo is optional', () => {
  const flavors = new Set(listShipKits().map((kit) => kit.flavor));
  expect(flavors.has('combat')).toBe(true);
  expect(flavors.has('utility')).toBe(true);
  expect(flavors.has('geo')).toBe(true);
  expect(listShipKits().every((kit) => kit.flavor === 'geo')).toBe(false);
  expect(getShipKit('quake').flavor).toBe('geo');
  expect(getShipKit('hauler').flavor).toBe('utility');
});

test('kit hull bake is locked to AD v2 topologies', () => {
  expect(KIT_HULLS_ARE_PLACEHOLDERS).toBe(false);
  expect(AD_V2_HULL_BAKE_LOCKED).toBe(true);
  expect(AD_V2_HULL_TOPOLOGY).toEqual({
    dart: 'needle',
    hauler: 'barge-hex',
    warden: 'delta-shield-arc',
    skirmisher: 'y-fork',
    quake: 'terraced-mountain',
  });
  expect(AD_V2_HULL_SHEET.playScalePx).toBe(32);
  expect(AD_V2_HULL_SHEET.stroke).toBe('#5EEAD4');
  expect(listShipKits().every((kit) => !('hull' in kit))).toBe(true);
});

test('applyShipKitToShip is shared for human and bot hulls', () => {
  const ship = new Ship({ isBot: true, kitId: 'hauler' });
  expect(ship.kitId).toBe('hauler');
  expect(ship.maxHealth).toBe(140);
  applyShipKitToShip(ship, 'skirmisher');
  expect(ship.kitId).toBe('skirmisher');
  expect(ship.maxHealth).toBe(80);
});
