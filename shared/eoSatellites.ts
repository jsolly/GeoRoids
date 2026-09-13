/**
 * The six environmental-observation birds that make up the collectible pickup
 * roster. This is shared protocol data: the server uses it to choose a
 * silhouette, while the client uses the same stable key to select the matching
 * canonical hardware outline.
 */
export type SatelliteTypeId =
  | 'landsat-7'
  | 'terra'
  | 'aqua'
  | 'goes-16'
  | 'envisat'
  | 'worldview-3';

export const EO_SATELLITE_HULL_COLOR = '#C4B5FD';

export interface SatelliteProfile {
  readonly typeId: SatelliteTypeId;
  readonly displayName: string;
  /** Stable key shared by the runtime outline and canonical SVG pack. */
  readonly assetKey: `eo/${SatelliteTypeId}`;
  readonly hullColor: string;
}

export const SATELLITE_PROFILES = [
  {
    typeId: 'landsat-7',
    displayName: 'Landsat 7',
    assetKey: 'eo/landsat-7',
    hullColor: EO_SATELLITE_HULL_COLOR,
  },
  {
    typeId: 'terra',
    displayName: 'Terra',
    assetKey: 'eo/terra',
    hullColor: EO_SATELLITE_HULL_COLOR,
  },
  {
    typeId: 'aqua',
    displayName: 'Aqua',
    assetKey: 'eo/aqua',
    hullColor: EO_SATELLITE_HULL_COLOR,
  },
  {
    typeId: 'goes-16',
    displayName: 'GOES-16',
    assetKey: 'eo/goes-16',
    hullColor: EO_SATELLITE_HULL_COLOR,
  },
  {
    typeId: 'envisat',
    displayName: 'ENVISAT',
    assetKey: 'eo/envisat',
    hullColor: EO_SATELLITE_HULL_COLOR,
  },
  {
    typeId: 'worldview-3',
    displayName: 'WorldView-3',
    assetKey: 'eo/worldview-3',
    hullColor: EO_SATELLITE_HULL_COLOR,
  },
] as const satisfies readonly SatelliteProfile[];

export function satelliteProfileAt(index: number): SatelliteProfile {
  const normalized = Math.abs(Math.trunc(index)) % SATELLITE_PROFILES.length;
  return SATELLITE_PROFILES[normalized] ?? SATELLITE_PROFILES[0];
}
