/**
 * The six environmental-observation birds that make up the ambient NPC
 * roster. This is shared protocol data: the server uses it to choose a
 * silhouette and firing cadence, while the client uses the same stable key to
 * select the matching canonical hardware outline.
 */
export type SatelliteTypeId =
  | 'landsat-7'
  | 'terra'
  | 'aqua'
  | 'goes-16'
  | 'envisat'
  | 'worldview-3';

export type SatelliteShotManner =
  | 'steady-optical-ping'
  | 'wide-modis-sweep'
  | 'microwave-spin-burst'
  | 'geo-weather-beam'
  | 'radar-plank-sweep'
  | 'sharp-vhr-stab';

/** Projectile geometry behind each mission's human-readable firing manner. */
export type SatelliteShotPattern =
  | 'steady'
  | 'wide-sweep'
  | 'spin-burst'
  | 'weather-beam'
  | 'radar-sweep'
  | 'precision-stab';

export const EO_SATELLITE_HULL_COLOR = '#C4B5FD';

export interface SatelliteProfile {
  readonly typeId: SatelliteTypeId;
  readonly displayName: string;
  /** Stable key shared by the runtime outline and canonical SVG pack. */
  readonly assetKey: `eo/${SatelliteTypeId}`;
  readonly shotManner: SatelliteShotManner;
  readonly shotPattern: SatelliteShotPattern;
  readonly hullColor: string;
  readonly cadenceFrames: number;
  readonly aimJitter: number;
  readonly burstCount: number;
  readonly burstGapFrames: number;
  readonly spreadRadians: number;
  readonly speedMultiplier: number;
}

export const SATELLITE_PROFILES = [
  {
    typeId: 'landsat-7',
    displayName: 'Landsat 7',
    assetKey: 'eo/landsat-7',
    shotManner: 'steady-optical-ping',
    shotPattern: 'steady',
    hullColor: EO_SATELLITE_HULL_COLOR,
    cadenceFrames: 112,
    aimJitter: 0.035,
    burstCount: 1,
    burstGapFrames: 0,
    spreadRadians: 0,
    speedMultiplier: 1,
  },
  {
    typeId: 'terra',
    displayName: 'Terra',
    assetKey: 'eo/terra',
    shotManner: 'wide-modis-sweep',
    shotPattern: 'wide-sweep',
    hullColor: EO_SATELLITE_HULL_COLOR,
    cadenceFrames: 148,
    aimJitter: 0.02,
    burstCount: 3,
    burstGapFrames: 4,
    spreadRadians: 0.16,
    speedMultiplier: 0.96,
  },
  {
    typeId: 'aqua',
    displayName: 'Aqua',
    assetKey: 'eo/aqua',
    shotManner: 'microwave-spin-burst',
    shotPattern: 'spin-burst',
    hullColor: EO_SATELLITE_HULL_COLOR,
    cadenceFrames: 190,
    aimJitter: 0.12,
    burstCount: 6,
    burstGapFrames: 7,
    spreadRadians: 0.32,
    speedMultiplier: 1.05,
  },
  {
    typeId: 'goes-16',
    displayName: 'GOES-16',
    assetKey: 'eo/goes-16',
    shotManner: 'geo-weather-beam',
    shotPattern: 'weather-beam',
    hullColor: EO_SATELLITE_HULL_COLOR,
    cadenceFrames: 172,
    aimJitter: 0,
    burstCount: 4,
    burstGapFrames: 2,
    spreadRadians: 0,
    speedMultiplier: 1.35,
  },
  {
    typeId: 'envisat',
    displayName: 'ENVISAT',
    assetKey: 'eo/envisat',
    shotManner: 'radar-plank-sweep',
    shotPattern: 'radar-sweep',
    hullColor: EO_SATELLITE_HULL_COLOR,
    cadenceFrames: 132,
    aimJitter: 0.025,
    burstCount: 2,
    burstGapFrames: 6,
    spreadRadians: 0.24,
    speedMultiplier: 0.9,
  },
  {
    typeId: 'worldview-3',
    displayName: 'WorldView-3',
    assetKey: 'eo/worldview-3',
    shotManner: 'sharp-vhr-stab',
    shotPattern: 'precision-stab',
    hullColor: EO_SATELLITE_HULL_COLOR,
    cadenceFrames: 84,
    aimJitter: 0.018,
    burstCount: 1,
    burstGapFrames: 0,
    spreadRadians: 0,
    speedMultiplier: 1.6,
  },
] as const satisfies readonly SatelliteProfile[];

export function satelliteProfileAt(index: number): SatelliteProfile {
  const normalized = Math.abs(Math.trunc(index)) % SATELLITE_PROFILES.length;
  return SATELLITE_PROFILES[normalized] ?? SATELLITE_PROFILES[0];
}

export function satelliteProfileForType(typeId: SatelliteTypeId): SatelliteProfile {
  return SATELLITE_PROFILES.find((profile) => profile.typeId === typeId) ?? SATELLITE_PROFILES[0];
}
