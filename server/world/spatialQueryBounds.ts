import { WORLD } from '../../shared/world';
import type { Position } from '../../shared-types';

/** Roundoff may admit a point just outside a literal box; exact predicates run afterward. */
export function spatialQueryBounds(position: Position, radius: number) {
  const padding =
    32 *
    Number.EPSILON *
    Math.max(WORLD.radius, Math.abs(position.x), Math.abs(position.y), Math.abs(radius));
  return {
    minX: position.x - radius - padding,
    minY: position.y - radius - padding,
    maxX: position.x + radius + padding,
    maxY: position.y + radius + padding,
  };
}
