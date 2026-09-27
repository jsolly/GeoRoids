import { contourLockSpeed, contourLockVelocity } from '../../shared/contourLock';
import type { ContourLockState, Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { findContourCapture } from '../physics/terrain/contourCapture';
import { type Heightfield, sampleGradient, sampleHeight } from '../physics/terrain/heightfield';
import { getTerrainField } from '../physics/terrain/terrainSession';
import { canvasManager } from './canvasSurface';

let cached: { field: Heightfield; height: number; x: number; y: number; path: Path2D } | null =
  null;

/** Preview the catchable track and keep its exact level visible across render patches. */
export function drawContourTrack(
  position: Position,
  angle: number,
  lock: ContourLockState | null
): void {
  const ctx = canvasManager.getContext();
  const target = lock ?? findContourCapture(position, angle);
  if (!ctx || !target) {
    return;
  }
  const field = getTerrainField();
  if (
    !cached ||
    cached.field !== field ||
    cached.height !== target.height ||
    Math.hypot(position.x - cached.x, position.y - cached.y) > 24
  ) {
    const start = { ...position };
    for (let iteration = 0; iteration < 3; iteration++) {
      const gradient = sampleGradient(field, start.x, start.y);
      const magnitudeSquared = gradient.x * gradient.x + gradient.y * gradient.y;
      if (magnitudeSquared <= 1e-12) {
        break;
      }
      const correction = (target.height - sampleHeight(field, start.x, start.y)) / magnitudeSquared;
      start.x += gradient.x * correction;
      start.y += gradient.y * correction;
    }
    const path = new Path2D();
    for (const direction of [-1, 1] as const) {
      const point = { ...start };
      path.moveTo(point.x, point.y);
      for (let step = 0; step < 24; step++) {
        const velocity = contourLockVelocity(
          point,
          { height: target.height, direction },
          8 / contourLockSpeed(1)
        );
        if (!velocity) {
          break;
        }
        point.x += velocity.x;
        point.y += velocity.y;
        path.lineTo(point.x, point.y);
      }
    }
    cached = { field, height: target.height, x: position.x, y: position.y, path };
  }
  ctx.save();
  canvasManager.applyWorldTransform(ctx, position);
  ctx.strokeStyle = lock ? PALETTE.LOCAL : PALETTE.CONTOUR;
  ctx.globalAlpha = lock ? 0.5 : 0.3;
  ctx.lineWidth = (lock ? 1.5 : 1) / canvasManager.getPlayfieldScale();
  ctx.stroke(cached.path);
  ctx.restore();
}
