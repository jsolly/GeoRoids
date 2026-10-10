import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SatellitePickupData } from '../../../shared-types';
import { GAME, SATELLITE_PICKUP } from '../../../src/constants';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { preferredHaulerUtility } from '../../../src/entities/ship/haulerUtility';
import { preferredScoutUtility } from '../../../src/entities/ship/scoutUtility';
import { NetworkManager } from '../../../src/network/networkManager';
import {
  equipInventorySatellite,
  equipInventoryUtility,
  readInventoryView,
  readSchematicSelection,
} from '../../../src/runtime/inventory';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

const pickups = SatellitePickupManager.getInstance();
const network = NetworkManager.getInstance();

function satellite(id: string, ownerId: string): SatellitePickupData {
  return {
    id,
    ownerId,
    name: `Satellite ${id}`,
    typeId: 'landsat-7',
    assetKey: 'eo/landsat-7',
    position: { x: 100, y: 200 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    radius: 12,
    color: '#C4B5FD',
    state: 'stored',
    health: 24.1,
    maxHealth: 50,
  };
}

function localPlayer() {
  const player = PlayerManager.getInstance().getLocalPlayer();
  if (!player) {
    throw new Error('The test pilot must exist');
  }
  return player;
}

beforeAll(() => {
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

beforeEach(() => {
  pickups.clear();
  localStorage.clear();
  resetSafeStorage();
  PlayerManager.getInstance().createLocalPlayer('hauler');
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(true);
  vi.spyOn(network, 'getLocalPlayerId').mockReturnValue('wire-pilot');
  vi.spyOn(network, 'sendMessage').mockReturnValue(true);
});

afterEach(() => {
  pickups.clear();
  vi.restoreAllMocks();
  localStorage.clear();
  resetSafeStorage();
});

test('inventory pages expose only owned satellites and clamp after removal without leaking live entities', () => {
  const pilot = localPlayer();
  pilot.silk = 3;
  const owned = Array.from({ length: 53 }, (_, index) => satellite(`owned-${index}`, pilot.id));
  pickups.syncFromServer([...owned, satellite('foreign', 'other')]);
  const pages = [0, 1, 2].map(readInventoryView);
  expect(pages.map(({ items }) => items.length)).toEqual([24, 24, 5]);
  expect(pages.flatMap(({ items }) => items.map(({ id }) => id))).toEqual(
    owned.map(({ id }) => id)
  );
  expect(pages[0]).toMatchObject({ total: 53, pages: 3, silk: 3, kitName: 'Hauler' });
  expect(pages[0]?.items[0]).toEqual({
    id: 'owned-0',
    name: 'Satellite owned-0',
    health: 25,
    maxHealth: 50,
    remainingSeconds: Math.ceil(((24.1 / 50) * SATELLITE_PICKUP.LIFETIME_FRAMES) / GAME.FPS),
    equipped: false,
  });
  expect(readInventoryView(99).page).toBe(2);
  expect(readInventoryView(-1).page).toBe(0);
  expect(readInventoryView(Number.NaN).page).toBe(0);
  const snapshot = readInventoryView(0);
  pickups.syncFromServer(owned.map((pickup) => ({ ...pickup, health: 10 })));
  expect(snapshot.items[0]?.health).toBe(25);
  expect(readInventoryView(0).items[0]?.health).toBe(10);
  pickups.syncFromServer([satellite('remaining', pilot.id)]);
  expect(readInventoryView(2)).toMatchObject({ page: 0, pages: 1, total: 1 });
  expect(snapshot.items[0]?.id).toBe('owned-0');
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.items)).toBe(true);
  expect(Object.isFrozen(snapshot.items[0])).toBe(true);
  pickups.clear();
  expect(readInventoryView(2)).toMatchObject({ page: 0, pages: 1, total: 0, items: [] });
});

test('satellite equip rechecks connection, ownership, live ship, transit and existing equipment at command time', () => {
  const pilot = localPlayer();
  const owned = satellite('owned', pilot.id);
  pickups.syncFromServer([owned, satellite('foreign', 'other')]);
  equipInventorySatellite('missing');
  equipInventorySatellite('foreign');
  expect(network.sendMessage).not.toHaveBeenCalled();
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(false);
  equipInventorySatellite('owned');
  expect(readInventoryView(0).canEquipSatellite).toBe(false);
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(true);
  pilot.ship.health = 0;
  equipInventorySatellite('owned');
  pilot.ship.health = 100;
  pilot.ship.exploding = true;
  equipInventorySatellite('owned');
  pilot.ship.exploding = false;
  pilot.ship.furnaceTransit = { sourceId: 'a', destinationId: 'b', startedAt: 0, durationMs: 500 };
  equipInventorySatellite('owned');
  pilot.ship.furnaceTransit = null;
  pickups.syncFromServer([{ ...owned, state: 'orbiting' }]);
  equipInventorySatellite('owned');
  pickups.syncFromServer([owned, { ...satellite('active', pilot.id), state: 'orbiting' }]);
  equipInventorySatellite('owned');
  expect(network.sendMessage).not.toHaveBeenCalled();
  pickups.syncFromServer([owned]);
  expect(readInventoryView(0).canEquipSatellite).toBe(true);
  equipInventorySatellite('owned');
  expect(network.sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'equipSatellite',
    id: 'wire-pilot',
    data: { pickupId: 'owned' },
  });
  expect(pickups.get('owned')?.state).toBe('stored');
});

test('a Hauler swaps only available matching tools and keeps prediction, storage and wire command aligned', () => {
  const pilot = localPlayer();
  equipInventoryUtility('survey_probe');
  equipInventoryUtility('resource_tap');
  expect(network.sendMessage).not.toHaveBeenCalled();
  expect(readInventoryView(0).tools.find(({ id }) => id === 'resource_tap')?.available).toBe(false);
  pilot.ship.equipment = ['resource_tap'];
  pilot.ship.harpoonTargetId = 'rock';
  pilot.ship.furnaceTransit = { sourceId: 'a', destinationId: 'b', startedAt: 0, durationMs: 500 };
  equipInventoryUtility('resource_tap');
  expect(network.sendMessage).not.toHaveBeenCalled();
  pilot.ship.furnaceTransit = null;
  equipInventoryUtility('resource_tap');
  expect(pilot.ship.haulerUtility).toBe('resource_tap');
  expect(pilot.ship.harpoonTargetId).toBeNull();
  expect(preferredHaulerUtility()).toBe('resource_tap');
  expect(readSchematicSelection()).toMatchObject({
    kitId: 'hauler',
    haulerUtility: 'resource_tap',
  });
  expect(network.sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'setHaulerUtility',
    id: 'wire-pilot',
    data: { utilityId: 'resource_tap' },
  });
});

test('a Scout tool swap stops predicted scanning and preserves the offline selection without sending', () => {
  const pilot = PlayerManager.getInstance().createLocalPlayer('scout');
  pilot.ship.equipment = ['survey_probe'];
  pilot.ship.abilityActiveFrames = 80;
  pilot.ship.abilityCooldownFrames = 120;
  equipInventoryUtility('tow_cable');
  expect(network.sendMessage).not.toHaveBeenCalled();
  equipInventoryUtility('survey_probe');
  expect(pilot.ship.abilityActiveFrames).toBe(0);
  expect(pilot.ship.abilityCooldownFrames).toBe(120);
  expect(preferredScoutUtility()).toBe('survey_probe');
  expect(network.sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'setScoutUtility',
    id: 'wire-pilot',
    data: { utilityId: 'survey_probe' },
  });
  vi.mocked(network.sendMessage).mockClear();
  vi.spyOn(network, 'isConnected', 'get').mockReturnValue(false);
  equipInventoryUtility('mineral_scan');
  expect(pilot.ship.scoutUtility).toBe('mineral_scan');
  expect(preferredScoutUtility()).toBe('mineral_scan');
  expect(network.sendMessage).not.toHaveBeenCalled();
});
