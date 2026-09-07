import type { Position } from '../../../shared-types';
import { pointsForRoidSize } from '../../entities/roid/roidScore';
import { getGameBoundary } from '../boundary';

/** Same rounding as `Point.distance` — keep combat feel, drop Point allocs. */
function flooredDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.floor(Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2));
}

/** Discrete laser radius used by point and swept laser tests. */
export const LASER_HIT_RADIUS = 2;

/**
 * Extra slack when the server validates a client-reported laser↔roid hit.
 * Covers one-way latency while still rejecting far-away phantom reports.
 */
export const LASER_ROID_AUTHORITY_SLOP = 64;

/**
 * Check if two circular objects are colliding
 */
export function checkCircularCollision(
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

/**
 * Check if a laser hits a circular target (asteroid, player, or bot).
 */
export function checkLaserHit(
  laserPos: Position,
  targetPos: Position,
  targetRadius: number
): boolean {
  return checkCircularCollision(laserPos, LASER_HIT_RADIUS, targetPos, targetRadius);
}

/**
 * Check if a laser hits an asteroid
 */
export function checkLaserAsteroidCollision(
  laserPos: Position,
  asteroidPos: Position,
  asteroidRadius: number
): boolean {
  return checkLaserHit(laserPos, asteroidPos, asteroidRadius);
}

/**
 * Segment-vs-circle test so a 5px laser step cannot tunnel through a
 * moving roid that a point sample would miss on a glancing frame.
 */
export function checkLaserAsteroidCollisionSwept(
  from: Position,
  to: Position,
  asteroidPos: Position,
  asteroidRadius: number
): boolean {
  const hitRadius = asteroidRadius + LASER_HIT_RADIUS;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return checkLaserAsteroidCollision(to, asteroidPos, asteroidRadius);
  }

  const t = Math.max(
    0,
    Math.min(1, ((asteroidPos.x - from.x) * dx + (asteroidPos.y - from.y) * dy) / lengthSq)
  );
  const closestX = from.x + dx * t;
  const closestY = from.y + dy * t;
  const distSq = (closestX - asteroidPos.x) ** 2 + (closestY - asteroidPos.y) ** 2;
  return distSq < hitRadius * hitRadius;
}

/** True when a reported laser is close enough to the server asteroid to count. */
export function isLaserNearAsteroid(
  laserPos: Position,
  asteroidPos: Position,
  asteroidRadius: number,
  slop: number = LASER_ROID_AUTHORITY_SLOP
): boolean {
  const dx = laserPos.x - asteroidPos.x;
  const dy = laserPos.y - asteroidPos.y;
  const limit = asteroidRadius + LASER_HIT_RADIUS + slop;
  return dx * dx + dy * dy <= limit * limit;
}

/** Server-authoritative score for a destroyed roid. Do not trust client points. */
export function asteroidPointsForRadius(radius: number): number {
  return pointsForRoidSize(radius);
}

/**
 * Check if a laser hits a ship/bot
 */
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
