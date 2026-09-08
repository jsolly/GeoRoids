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

describe('ambient EO satellite roster', () => {
  test('every mission has a stable hardware hook and a distinct shot pattern', () => {
    expect(SATELLITE_PROFILES.map((profile) => profile.typeId)).toEqual(EXPECTED_IDS);
    expect(SATELLITE_PROFILES.map((profile) => profile.assetKey)).toEqual(
      EXPECTED_IDS.map((id) => `eo/${id}`)
    );
    expect(new Set(SATELLITE_PROFILES.map((profile) => profile.shotPattern)).size).toBe(
      EXPECTED_IDS.length
    );
    expect(
      SATELLITE_PROFILES.every((profile) => profile.hullColor === EO_SATELLITE_HULL_COLOR)
    ).toBe(true);
  });

  test('profile firing geometry distinguishes sweeps, bursts, beam, and precision fire', () => {
    const terra = SATELLITE_PROFILES.find((profile) => profile.typeId === 'terra');
    const aqua = SATELLITE_PROFILES.find((profile) => profile.typeId === 'aqua');
    const goes = SATELLITE_PROFILES.find((profile) => profile.typeId === 'goes-16');
    const worldview = SATELLITE_PROFILES.find((profile) => profile.typeId === 'worldview-3');

    expect(terra?.burstCount).toBeGreaterThan(1);
    expect(terra?.spreadRadians).toBeGreaterThan(0);
    expect(aqua?.burstGapFrames).toBeGreaterThan(terra?.burstGapFrames ?? 0);
    expect(goes?.speedMultiplier).toBeGreaterThan(1);
    expect(worldview?.burstCount).toBe(1);
    expect(worldview?.spreadRadians).toBe(0);
  });
});
