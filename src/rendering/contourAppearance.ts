import type { Position } from '../../shared-types';
import { TERRAIN } from '../physics/terrain/terrainConfig';

/** Hue 211°, the quiet contour ink. Lightness is the only change along the ramp. */
const CONTOUR_SATURATION = 0.15;
const UPHILL_LIGHTNESS = 0.36;
const DOWNHILL_LIGHTNESS = 0.72;

function slateChannels(lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * CONTOUR_SATURATION;
  // Hue 211 sits in the blue sector, so red carries only the lightness match.
  const x = chroma * (1 - Math.abs(((211 / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  return [
    Math.round(match * 255),
    Math.round((x + match) * 255),
    Math.round((chroma + match) * 255),
  ];
}

function rampLightness(slope: number, passage: number): number {
  const span = TERRAIN.TRAVEL_STEEP_GRADIENT - TERRAIN.TRAVEL_FLAT_GRADIENT;
  const amount = Math.min(1, Math.max(0, (Math.abs(slope) - TERRAIN.TRAVEL_FLAT_GRADIENT) / span));
  const mix = amount * amount * (3 - 2 * amount);
  const alongSlope = slope > 0 ? 0.5 * (1 - mix) : 0.5 * (1 + mix);
  const shortcut = Math.min(1, Math.max(0, passage));
  const position = alongSlope + (1 - alongSlope) * shortcut;
  return UPHILL_LIGHTNESS + (DOWNHILL_LIGHTNESS - UPHILL_LIGHTNESS) * position;
}

/** Darker slate uphill, lighter slate downhill. Shortcuts stay on the light end. */
export function contourSlopeColor(slope: number, alpha: number, passage = 0): string {
  const [red, green, blue] = slateChannels(rampLightness(slope, passage));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
