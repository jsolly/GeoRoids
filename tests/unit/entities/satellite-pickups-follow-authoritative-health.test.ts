import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SatellitePickupData } from '../../../shared-types';
import * as destructionSounds from '../../../src/audio/destructionSounds';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';

const manager = SatellitePickupManager.getInstance();
const landsat: SatellitePickupData = {
  id: 'landsat-health',
  name: 'Landsat 7',
  typeId: 'landsat-7',
  assetKey: 'eo/landsat-7',
  position: { x: 100, y: 200 },
  velocity: { x: 0, y: 0 },
  angle: 0,
  radius: 12,
  color: '#C4B5FD',
  state: 'loose',
  ownerId: null,
  health: 50,
  maxHealth: 50,
};

beforeEach(() => manager.clear());
afterEach(() => vi.restoreAllMocks());

test('a collected satellite keeps its identity while damage and breakage arrive in snapshots', () => {
  manager.syncFromServer([landsat]);
  const pickup = manager.get(landsat.id);
  manager.syncFromServer([{ ...landsat, state: 'orbiting', ownerId: 'pilot', health: 25 }]);
  expect(manager.get(landsat.id)).toBe(pickup);
  expect(pickup).toMatchObject({
    state: 'orbiting',
    ownerId: 'pilot',
    health: 25,
    maxHealth: 50,
  });
  manager.syncFromServer([{ ...landsat, state: 'broken', health: 0 }]);
  expect(pickup).toMatchObject({ state: 'broken', ownerId: null, health: 0 });
  manager.syncFromServer([landsat]);
  expect(pickup).toMatchObject({ state: 'loose', health: 50 });
  manager.syncFromServer([]);
  expect(manager.getAll()).toEqual([]);
});

test('orbital breakage sounds once and a reconnect to a broken orbital stays silent', () => {
  const sound = vi.spyOn(destructionSounds, 'playDestructionSound').mockImplementation(() => {});
  const broken: SatellitePickupData = { ...landsat, state: 'broken', health: 0 };
  manager.syncFromServer([broken]);
  expect(sound).not.toHaveBeenCalled();
  manager.syncFromServer([landsat]);
  manager.syncFromServer([broken]);
  manager.syncFromServer([broken]);
  expect(sound).toHaveBeenCalledExactlyOnceWith('satellite', landsat.position);
  manager.clear();
  manager.syncFromServer([broken]);
  expect(sound).toHaveBeenCalledTimes(1);
});
