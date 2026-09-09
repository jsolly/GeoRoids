import { TERRAIN } from './terrainConfig';

export interface Heightfield {
  /** Retained for room protocol compatibility; all rooms use the central mountain. */
  seed: number;
  cx: number;
  cy: number;
  radius: number;
}

export interface HeightfieldBounds {
  cx?: number;
  cy?: number;
  radius: number;
}

export function createHeightfield(seed: number, bounds: HeightfieldBounds): Heightfield {
  return { seed, cx: bounds.cx ?? 0, cy: bounds.cy ?? 0, radius: bounds.radius };
}

/** One smooth summit at the arena center, descending to zero at its rim. */
export function sampleHeight(field: Heightfield, x: number, y: number): number {
  const distance = Math.hypot(x - field.cx, y - field.cy);
  if (distance >= field.radius) {
    return 0;
  }
  return (TERRAIN.PEAK_HEIGHT / 2) * (1 + Math.cos((Math.PI * distance) / field.radius));
}

/** Analytic gradient avoids sampling across the arena boundary or rounding at the peak. */
export function sampleGradientInto(
  out: { x: number; y: number },
  field: Heightfield,
  x: number,
  y: number
): { x: number; y: number } {
  const dx = x - field.cx;
  const dy = y - field.cy;
  const distance = Math.hypot(dx, dy);
  if (distance === 0 || distance >= field.radius) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const slope =
    (-TERRAIN.PEAK_HEIGHT * Math.PI * Math.sin((Math.PI * distance) / field.radius)) /
    (2 * field.radius * distance);
  out.x = slope * dx;
  out.y = slope * dy;
  return out;
}

export function sampleGradient(field: Heightfield, x: number, y: number): { x: number; y: number } {
  return sampleGradientInto({ x: 0, y: 0 }, field, x, y);
}
