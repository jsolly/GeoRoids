import type { Position } from '../../../shared-types';
import { pointsForRoidSize } from '../../entities/roid/roidScore';
import { getGameBoundary } from '../boundary';

/** Same rounding as `Point.distance` — keep combat feel, drop Point allocs. */
function flooredDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.floor(Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2));
}

/** Discrete laser radius used by point and swept laser tests. */
const LASER_HIT_RADIUS = 2;

/**
 * Check if two circular objects are colliding
 */
function checkCircularCollision(
  pos1: Position,
  radius1: number,
  pos2: Position,
  radius2: number
): boolean {
  return flooredDistance(pos1.x, pos1.y, pos2.x, pos2.y) < radius1 + radius2;
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

/** Check if a projectile hits a circular target. */
export function checkLaserHit(
  laserPos: Position,
  targetPos: Position,
  targetRadius: number
): boolean {
  return checkCircularCollision(laserPos, LASER_HIT_RADIUS, targetPos, targetRadius);
}

/** Server-authoritative score for a destroyed roid. Do not trust client points. */
export function asteroidPointsForRadius(radius: number): number {
  return pointsForRoidSize(radius);
}

/** Check if a satellite projectile hits a ship/bot. */
export function checkLaserShipCollision(
  laserPos: Position,
  shipPos: Position,
  shipRadius: number
): boolean {
  return checkLaserHit(laserPos, shipPos, shipRadius);
}

/**
 * Check if two ships are colliding
 */
export function checkShipCollision(
  ship1Pos: Position,
  ship1Radius: number,
  ship2Pos: Position,
  ship2Radius: number
): boolean {
  const isColliding = checkCircularCollision(ship1Pos, ship1Radius, ship2Pos, ship2Radius);

  return isColliding;
}
