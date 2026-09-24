import type { Position, TerrainSpider } from '../../shared-types';
import type { ContourLevel } from '../physics/terrain/contours';
import { contourCandidates } from './contourSpatialIndex';

/** Feet are projected onto the very same line segments drawn as terrain. */
export function spiderFootContacts(
  spider: Pick<TerrainSpider, 'position' | 'angle'>,
  levels: readonly ContourLevel[],
  time: number
): Position[] {
  const segments = levels.flatMap((_, ordinal) =>
    contourCandidates(levels, ordinal, {
      ...spider.position,
      width: 768,
      height: 768,
      scale: 1,
      pad: 0,
    })
  );
  // Sparse hills can have widely separated isolines. Their nearby patch remains bounded.
  const available = segments.length > 0 ? segments : levels.flatMap((level) => level.segments);
  if (available.length === 0) {
    return [];
  }
  const cosine = Math.cos(spider.angle);
  const sine = Math.sin(spider.angle);
  const feet: Position[] = [];
  for (const side of [-1, 1]) {
    for (let leg = 0; leg < 4; leg++) {
      const gait = Math.sin(time * 8 + leg * Math.PI + side) * 9;
      const localX = (1.5 - leg) * 30 + gait;
      const localY = side * (48 + Math.abs(gait));
      const desired = {
        x: spider.position.x + localX * cosine - localY * sine,
        y: spider.position.y + localX * sine + localY * cosine,
      };
      let best: Position | undefined;
      let bestDistance = Infinity;
      for (const segment of available) {
        const dx = segment.bx - segment.ax;
        const dy = segment.by - segment.ay;
        const lengthSquared = dx * dx + dy * dy;
        const fraction =
          lengthSquared > 0
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((desired.x - segment.ax) * dx + (desired.y - segment.ay) * dy) / lengthSquared
                )
              )
            : 0;
        const point = { x: segment.ax + dx * fraction, y: segment.ay + dy * fraction };
        const distance = (point.x - desired.x) ** 2 + (point.y - desired.y) ** 2;
        // Prefer the leg's own side so left and right legs do not cross through the abdomen.
        const lateral =
          -(point.x - spider.position.x) * sine + (point.y - spider.position.y) * cosine;
        const score = distance + (lateral * side < 0 ? 16000 : 0);
        if (score < bestDistance) {
          best = point;
          bestDistance = score;
        }
      }
      if (best) {
        feet.push(best);
      }
    }
  }
  return feet;
}
