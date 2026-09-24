import type { ContourLevel } from '../physics/terrain/contours';
import { type Heightfield, sampleGradient } from '../physics/terrain/heightfield';
import { passageStrength } from '../physics/terrain/passages';

type Segment = ContourLevel['segments'][number];
const slopeCache = new WeakMap<Segment, { gradient: { x: number; y: number }; passage: number }>();

/** Cache the actual gradient so a changed heading can immediately preview the route. */
export function contourSlope(segment: Segment, field: Heightfield) {
  let slope = slopeCache.get(segment);
  if (!slope) {
    const gradient = sampleGradient(
      field,
      (segment.ax + segment.bx) / 2,
      (segment.ay + segment.by) / 2
    );
    slope = {
      gradient,
      passage: passageStrength(field, (segment.ax + segment.bx) / 2, (segment.ay + segment.by) / 2),
    };
    slopeCache.set(segment, slope);
  }
  return slope;
}

export function warmContourSlopes(levels: readonly ContourLevel[], field: Heightfield): void {
  for (const level of levels) {
    for (const segment of level.segments) {
      contourSlope(segment, field);
    }
  }
}
