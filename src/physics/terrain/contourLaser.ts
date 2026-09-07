import { VISUAL } from '../../constants';
import { type Heightfield, sampleGradientInto } from './heightfield';
import { TERRAIN } from './terrainConfig';

export interface ContourLaserTick {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const gradientScratch = { x: 0, y: 0 };

export function contourLaserTickInto(
  out: ContourLaserTick,
  field: Heightfield,
  x: number,
  y: number,
  halfLen: number = VISUAL.CONTOUR_LASER_LENGTH / 2
): ContourLaserTick | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(halfLen) || halfLen <= 0) {
    return null;
  }

  sampleGradientInto(gradientScratch, field, x, y);
  const mag = Math.hypot(gradientScratch.x, gradientScratch.y);
  if (
    !Number.isFinite(gradientScratch.x) ||
    !Number.isFinite(gradientScratch.y) ||
    !Number.isFinite(mag) ||
    mag < TERRAIN.CONTOUR_LASER_MIN_GRAD
  ) {
    return null;
  }

  const tx = -gradientScratch.y / mag;
  const ty = gradientScratch.x / mag;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return null;
  }
  out.ax = x - tx * halfLen;
  out.ay = y - ty * halfLen;
  out.bx = x + tx * halfLen;
  out.by = y + ty * halfLen;
  return Number.isFinite(out.ax) &&
    Number.isFinite(out.ay) &&
    Number.isFinite(out.bx) &&
    Number.isFinite(out.by)
    ? out
    : null;
}

/**
 * Iso-tangent under a live shot. Same seed + same world point → same tick on
 * every client. Does not move the bolt or change hit tests.
 */
export function contourLaserTick(
  field: Heightfield,
  x: number,
  y: number,
  halfLen: number = VISUAL.CONTOUR_LASER_LENGTH / 2
): ContourLaserTick | null {
  return contourLaserTickInto({ ax: 0, ay: 0, bx: 0, by: 0 }, field, x, y, halfLen);
}

export function contourLaserTicksForShots(
  field: Heightfield,
  shots: readonly { x: number; y: number }[]
): ContourLaserTick[] {
  const ticks: ContourLaserTick[] = [];
  for (const shot of shots) {
    const tick = contourLaserTick(field, shot.x, shot.y);
    if (tick) {
      ticks.push(tick);
    }
  }
  return ticks;
}
