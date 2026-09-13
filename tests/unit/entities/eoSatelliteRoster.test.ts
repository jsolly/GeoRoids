import { describe, expect, test } from 'vitest';
import {
  EO_SATELLITE_HULL_COLOR,
  SATELLITE_PROFILES,
  type SatelliteTypeId,
} from '../../../shared/eoSatellites';

const EXPECTED_IDS: SatelliteTypeId[] = [
  'landsat-7',
  'terra',
  'aqua',
  'goes-16',
  'envisat',
  'worldview-3',
];

describe('Earth-observation satellite pickup roster', () => {
  test('every mission has a stable hardware hook and a distinct hull', () => {
    expect(SATELLITE_PROFILES.map((profile) => profile.typeId)).toEqual(EXPECTED_IDS);
    expect(SATELLITE_PROFILES.map((profile) => profile.assetKey)).toEqual(
      EXPECTED_IDS.map((id) => `eo/${id}`)
    );
    expect(new Set(SATELLITE_PROFILES.map((profile) => profile.displayName)).size).toBe(
      EXPECTED_IDS.length
    );
    expect(
      SATELLITE_PROFILES.every((profile) => profile.hullColor === EO_SATELLITE_HULL_COLOR)
    ).toBe(true);
  });
});
