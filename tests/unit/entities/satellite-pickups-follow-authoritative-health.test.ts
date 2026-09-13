import { beforeEach, expect, test } from 'vitest';
import type { SatellitePickupData } from '../../../shared-types';
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

test('a collected satellite keeps its identity while damage and breakage arrive in snapshots', () => {
  manager.syncFromServer([landsat]);
  const pickup = manager.get(landsat.id);
  manager.syncFromServer([{ ...landsat, state: 'orbiting', ownerId: 'pilot', health: 25 }]);
  expect(manager.get(landsat.id)).toBe(pickup);
  expect(pickup).toMatchObject({ state: 'orbiting', ownerId: 'pilot', health: 25, maxHealth: 50 });
  manager.syncFromServer([{ ...landsat, state: 'broken', health: 0 }]);
  expect(pickup).toMatchObject({ state: 'broken', ownerId: null, health: 0 });
  manager.syncFromServer([landsat]);
  expect(pickup).toMatchObject({ state: 'loose', health: 50 });
  manager.syncFromServer([]);
  expect(manager.getAll()).toEqual([]);
});
