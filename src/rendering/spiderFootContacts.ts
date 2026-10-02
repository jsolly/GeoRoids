import type { Position, TerrainSpider } from '../../shared-types';
import type { ContourLevel } from '../physics/terrain/contours';
import { createContourQuery } from './contourSpatialIndex';

const footCandidates = createContourQuery();
const SIDES = [-1, 1] as const;

/** Feet are projected onto the very same line segments drawn as terrain. */
export function spiderFootContacts(
  spider: Pick<TerrainSpider, 'position' | 'angle'>,
  levels: readonly ContourLevel[],
  time: number,
  reach = 1
): Position[] {
  const view = { ...spider.position, width: 768, height: 768, scale: 1, pad: 0 };
  const nearby = levels.map((_, ordinal) => footCandidates(levels, ordinal, view));
  // Sparse hills can have widely separated isolines. Their nearby patch remains bounded.
  const available = nearby.some((segments) => segments.length > 0)
    ? nearby
    : levels.map((level) => level.segments);
  if (!available.some((segments) => segments.length > 0)) {
    return [];
  }
  const cosine = Math.cos(spider.angle);
  const sine = Math.sin(spider.angle);
  const feet: Position[] = [];
  for (const side of SIDES) {
    for (let leg = 0; leg < 4; leg++) {
      const gait = Math.sin(time * 8 + leg * Math.PI + side) * 9;
      const localX = ((1.5 - leg) * 30 + gait) * reach;
      const localY = side * (48 + Math.abs(gait)) * reach;
      const desiredX = spider.position.x + localX * cosine - localY * sine;
      const desiredY = spider.position.y + localX * sine + localY * cosine;
      let bestX = 0;
      let bestY = 0;
      let bestDistance = Infinity;
      for (const segments of available) {
        for (const segment of segments) {
          const { ax, ay, bx, by } = segment;
          const dx = bx - ax;
          const dy = by - ay;
          const lengthSquared = dx * dx + dy * dy;
          const fraction =
            lengthSquared > 0
              ? Math.max(
                  0,
                  Math.min(1, ((desiredX - ax) * dx + (desiredY - ay) * dy) / lengthSquared)
                )
              : 0;
          const pointX = ax + dx * fraction;
          const pointY = ay + dy * fraction;
          const distance = (pointX - desiredX) ** 2 + (pointY - desiredY) ** 2;
          // Prefer the leg's own side so left and right legs do not cross through the abdomen.
          const lateral =
            -(pointX - spider.position.x) * sine + (pointY - spider.position.y) * cosine;
          const score = distance + (lateral * side < 0 ? 16000 : 0);
          if (score < bestDistance) {
            bestX = pointX;
            bestY = pointY;
            bestDistance = score;
          }
        }
      }
      if (bestDistance < Infinity) {
        feet.push({ x: bestX, y: bestY });
      }
    }
  }
  return feet;
}
