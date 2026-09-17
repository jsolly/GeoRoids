import type { Position } from '../../../shared-types';
import { getGameBoundary } from '../boundary';

/** Same rounding as `Point.distance` — keep combat feel, drop Point allocs. */
function flooredDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.floor(Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2));
}

/**
 * Check if a ship is outside the game boundary
 */
export function checkBoundaryCollision(shipPos: Position, shipRadius: number): boolean {
  const boundary = getGameBoundary();

  // Ship is outside boundary if its edge is beyond the boundary radius
  return (
    flooredDistance(shipPos.x, shipPos.y, boundary.cx, boundary.cy) + shipRadius > boundary.radius
  );
}
