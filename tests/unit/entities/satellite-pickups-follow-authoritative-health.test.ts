import { beforeEach, expect, test } from 'vitest';
import type { SatellitePickupData } from '../../../shared-types';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';

const manager = SatellitePickupManager.getInstance();
const echo: SatellitePickupData = {
  id: 'echo-health',
  name: 'Echo',
  typeId: 'echo',
  assetKey: 'pickup/echo',
  position: { x: 100, y: 200 },
  velocity: { x: 0, y: 0 },
  angle: 0,
  radius: 9,
  color: '#FBBF24',
  state: 'loose',
  ownerId: null,
  health: 50,
  maxHealth: 50,
};

beforeEach(() => manager.clear());

test('a collected satellite keeps its identity while damage and breakage arrive in snapshots', () => {
  manager.syncFromServer([echo]);
  const pickup = manager.get(echo.id);
  manager.syncFromServer([{ ...echo, state: 'orbiting', ownerId: 'pilot', health: 25 }]);
  expect(manager.get(echo.id)).toBe(pickup);
  expect(pickup).toMatchObject({ state: 'orbiting', ownerId: 'pilot', health: 25, maxHealth: 50 });
  manager.syncFromServer([{ ...echo, state: 'broken', health: 0 }]);
  expect(pickup).toMatchObject({ state: 'broken', ownerId: null, health: 0 });
  manager.syncFromServer([echo]);
  expect(pickup).toMatchObject({ state: 'loose', health: 50 });
  manager.syncFromServer([]);
  expect(manager.getAll()).toEqual([]);
});
