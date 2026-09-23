import type { Position } from '../../shared-types';
import { TERRAIN } from '../physics/terrain/terrainConfig';

/** Warm uphill, cool downhill, neutral when travel crosses the slope. */
export function contourSlopeColor(slope: number, alpha: number, passage = 0): string {
  const amount = Math.min(
    1,
    Math.max(0, Math.abs(slope) - TERRAIN.TRAVEL_FLAT_GRADIENT) /
      (TERRAIN.TRAVEL_STEEP_GRADIENT - TERRAIN.TRAVEL_FLAT_GRADIENT)
  );
  const mix = amount * amount * (3 - 2 * amount);
  const warm = slope > 0;
  // Bright violet marks the passage; meaningful slopes still take amber/blue priority.
  const baseR = 124 + (179 - 124) * passage;
  const baseG = 137 + (136 - 137) * passage;
  const baseB = 154 + (255 - 154) * passage;
  const r = Math.round(baseR + ((warm ? 220 : 103) - baseR) * mix);
  const g = Math.round(baseG + ((warm ? 164 : 168) - baseG) * mix);
  const b = Math.round(baseB + ((warm ? 91 : 223) - baseB) * mix);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Local climb along the straight route from the ship to a contour point. */
export function radialSlope(offset: Position, gradient: Position): number {
  const distance = Math.hypot(offset.x, offset.y);
  return distance === 0 ? 0 : (gradient.x * offset.x + gradient.y * offset.y) / distance;
}

/** A 75-degree cone with a soft five-degree fade at either edge. */
export function previewConeWeight(offset: Position, heading: Position): number {
  const distance = Math.hypot(offset.x, offset.y);
  if (distance === 0) {
    return 0;
  }
  const alignment = (offset.x * heading.x + offset.y * heading.y) / distance;
  const outer = Math.cos((37.5 * Math.PI) / 180);
  const inner = Math.cos((32.5 * Math.PI) / 180);
  const amount = Math.max(0, Math.min(1, (alignment - outer) / (inner - outer)));
  return amount * amount * (3 - 2 * amount);
}
