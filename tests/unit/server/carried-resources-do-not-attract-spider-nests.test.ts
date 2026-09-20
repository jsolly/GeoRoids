import { expect, test } from 'vitest';
import { spiderResources } from '../../../server/core/spiderResources';
import type { AsteroidData, LootData, SatellitePickupData } from '../../../shared-types';
import { ROID } from '../../../src/constants';

const ore: AsteroidData = {
  id: 'ore',
  position: { x: 5000, y: 5000 },
  velocity: { x: 0, y: 0 },
  size: 24,
  health: 75,
  maxHealth: 75,
  material: 'metal',
  jaggedness: 0.5,
  rotation: 0,
  angularVelocity: 0,
  vertices: 4,
  offsets: [1, 1, 1, 1],
};
const pickup: SatellitePickupData = {
  id: 'satellite',
  name: 'Terra',
  typeId: 'terra',
  assetKey: 'eo/terra',
  position: { x: 5000, y: 5000 },
  velocity: { x: 0, y: 0 },
  angle: 0,
  radius: 12,
  color: '#fff',
  state: 'loose',
  ownerId: null,
  health: 50,
  maxHealth: 50,
};

test('moving ore and carried satellites do not turn a pilot into a nest anchor', () => {
  expect(
    spiderResources(
      [{ ...ore, velocity: { x: 1, y: 0 } }],
      [],
      [
        { ...pickup, state: 'stored', ownerId: 'pilot' },
        { ...pickup, id: 'orbiting', state: 'orbiting', ownerId: 'pilot' },
      ]
    )
  ).toEqual([]);
});

test('colossal deposits and laser cores attract larger groups than ordinary ore and loose pickups', () => {
  const core: LootData = {
    id: 'core',
    position: ore.position,
    kind: 'laserCore',
    radius: 10,
    mass: 0,
  };
  const resources = spiderResources(
    [
      { ...ore, id: 'ice', material: 'ice' },
      ore,
      { ...ore, id: 'colossal', size: ROID.COLOSSAL_SIZE },
    ],
    [core],
    [pickup]
  );
  expect(resources.map(({ id, value }) => [id, value])).toEqual([
    ['ice', 0],
    ['ore', 1],
    ['colossal', 2],
    ['core', 2],
    ['satellite', 1],
  ]);
});
