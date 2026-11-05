import { CONTOUR_LOCK } from '../../shared/contourLock';
import type { Position } from '../../shared-types';
import { getTerrainContours } from '../physics/terrain/terrainSession';
import { createContourQuery } from './contourSpatialIndex';
import type { PlayfieldSize } from './playfieldCamera';

const nearby = createContourQuery();

/** Show the real nearby capture/hop lines, using the same flight patch as navigation. */
export function simpleScanNavigation(
  position: Position,
  flightViewport: Readonly<PlayfieldSize>,
  scale: number
) {
  const viewRadius =
    Math.hypot(flightViewport.width / 2, flightViewport.height / 2) / scale + 32 / scale;
  const levels = getTerrainContours(position, viewRadius);
  const radius = Math.max(CONTOUR_LOCK.captureRadius, CONTOUR_LOCK.hopRadius) + 32;
  const view = { ...position, width: radius * 2, height: radius * 2, scale: 1, pad: 0 };
  return levels.map((level, ordinal) => ({
    index: level.index,
    segments: nearby(levels, ordinal, view),
  }));
}
