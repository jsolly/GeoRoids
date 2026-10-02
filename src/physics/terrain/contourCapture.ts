import { CONTOUR_LOCK, contourLockDistance } from '../../../shared/contourLock';
import type { ContourLockState, Position } from '../../../shared-types';
import { canvasManager } from '../../rendering/canvasSurface';
import { createContourQuery } from '../../rendering/contourSpatialIndex';
import { sampleGradient } from './heightfield';
import { getTerrainContours, getTerrainField } from './terrainSession';

const captureCandidates = createContourQuery();

/** Capture only a visible nearby line, never an arbitrary implicit level in empty space. */
export function findContourCapture(position: Position, angle: number): ContourLockState | null {
  const viewport = canvasManager.getViewportSize();
  const scale = Math.max(canvasManager.getPlayfieldScale(), Number.EPSILON);
  const viewRadius = Math.hypot(viewport.width / 2, viewport.height / 2) / scale + 32 / scale;
  const levels = getTerrainContours(position, viewRadius);
  let nearest = CONTOUR_LOCK.captureRadius ** 2;
  let height: number | undefined;
  const view = {
    ...position,
    width: CONTOUR_LOCK.captureRadius * 2,
    height: CONTOUR_LOCK.captureRadius * 2,
    scale: 1,
    pad: 0,
  };
  for (let ordinal = 0; ordinal < levels.length; ordinal++) {
    const level = levels[ordinal];
    if (!level) {
      continue;
    }
    for (const segment of captureCandidates(levels, ordinal, view)) {
      const dx = segment.bx - segment.ax;
      const dy = segment.by - segment.ay;
      const length = dx * dx + dy * dy;
      const t =
        length > 0
          ? Math.max(
              0,
              Math.min(
                1,
                ((position.x - segment.ax) * dx + (position.y - segment.ay) * dy) / length
              )
            )
          : 0;
      const distance =
        (position.x - segment.ax - t * dx) ** 2 + (position.y - segment.ay - t * dy) ** 2;
      if (distance <= nearest) {
        nearest = distance;
        height = level.height;
      }
    }
  }
  if (height === undefined) {
    return null;
  }
  const gradient = sampleGradient(getTerrainField(), position.x, position.y);
  const direction = -gradient.y * Math.cos(angle) - gradient.x * Math.sin(angle) >= 0 ? 1 : -1;
  const state: ContourLockState = { height, direction };
  return contourLockDistance(position, state) <= CONTOUR_LOCK.captureRadius ? state : null;
}
