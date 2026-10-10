import { CONTOUR_LOCK, canHopContour, contourLockDistance } from '../../../shared/contourLock';
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

/** Reverse with a backward tangent flick; otherwise catch the first adjacent contour in reach. */
export function findContourHop(
  position: Position,
  previous: ContourLockState,
  flick: Position
): ContourLockState | null {
  const magnitude = Math.hypot(flick.x, flick.y);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return null;
  }
  const rx = flick.x / magnitude;
  const ry = flick.y / magnitude;
  const gradient = sampleGradient(getTerrainField(), position.x, position.y);
  const gradientLength = Math.hypot(gradient.x, gradient.y);
  const along = (-gradient.y * rx + gradient.x * ry) / gradientLength;
  if (along * previous.direction < -Math.SQRT1_2) {
    const reverse: ContourLockState = { ...previous, direction: previous.direction === 1 ? -1 : 1 };
    return canHopContour(position, previous, reverse) ? reverse : null;
  }
  const levels = getTerrainContours(position, CONTOUR_LOCK.hopRadius);
  const view = {
    ...position,
    width: CONTOUR_LOCK.hopRadius * 2,
    height: CONTOUR_LOCK.hopRadius * 2,
    scale: 1,
    pad: 0,
  };
  let nearest: number = CONTOUR_LOCK.hopRadius;
  let target: ContourLockState | null = null;
  for (let ordinal = 0; ordinal < levels.length; ordinal++) {
    const level = levels[ordinal];
    if (!level) {
      continue;
    }
    if (level.height === previous.height) {
      continue;
    }
    const candidate = { height: level.height, direction: previous.direction };
    if (!canHopContour(position, previous, candidate)) {
      continue;
    }
    for (const segment of captureCandidates(levels, ordinal, view)) {
      const sx = segment.bx - segment.ax;
      const sy = segment.by - segment.ay;
      const cross = rx * sy - ry * sx;
      if (Math.abs(cross) < 1e-9) {
        continue;
      }
      const dx = segment.ax - position.x;
      const dy = segment.ay - position.y;
      const distance = (dx * sy - dy * sx) / cross;
      const fraction = (dx * ry - dy * rx) / cross;
      if (distance > 0 && distance <= nearest && fraction >= 0 && fraction <= 1) {
        const landing = sampleGradient(
          getTerrainField(),
          position.x + rx * distance,
          position.y + ry * distance
        );
        const projection = (-landing.y * rx + landing.x * ry) / Math.hypot(landing.x, landing.y);
        // Nearly perpendicular flicks retain travel; a deliberate diagonal chooses its heading.
        candidate.direction =
          Math.abs(projection) <= 0.15 ? previous.direction : projection > 0 ? 1 : -1;
        nearest = distance;
        target = { ...candidate };
      }
    }
  }
  return target;
}
