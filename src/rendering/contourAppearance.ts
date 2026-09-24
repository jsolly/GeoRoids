import type { Position } from '../../shared-types';
import { TERRAIN } from '../physics/terrain/terrainConfig';

/** Hue 0. Lightness runs from a pale easy route to a very dark steep climb. */
const CONTOUR_SATURATION = 0.78;
const UPHILL_LIGHTNESS = 0.18;
const DOWNHILL_LIGHTNESS = 0.84;

function redChannels(lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * CONTOUR_SATURATION;
  const match = lightness - chroma / 2;
  return [Math.round((chroma + match) * 255), Math.round(match * 255), Math.round(match * 255)];
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

/** `#RRGGBB` for the same ramp, so demonstrations can stroke it as a hex. */
export function contourSlopeHex(slope: number, passage = 0): string {
  const [red, green, blue] = redChannels(rampLightness(slope, passage));
  const channel = (value: number) => value.toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/**
 * One red ramp. Steep climbs are very dark; descents and passages stay light.
 * The light end does not wrap, so an easy route can keep meeting easier ground.
 */
export function contourSlopeColor(slope: number, alpha: number, passage = 0): string {
  const hex = contourSlopeHex(slope, passage);
  const raw = hex.slice(1);
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
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
