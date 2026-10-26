import type { Position } from '../shared-types';
import { WORLD } from './world';

/** The circular world is fixed for this runtime and shared by all consumers. */
export const WORLD_BOUNDARY = Object.freeze<{ cx: number; cy: number; radius: number }>({
  cx: 0,
  cy: 0,
  radius: WORLD.radius,
});

/** Preserve the ship collision rule's historical whole-unit rounding. */
export function checkBoundaryCollision(shipPos: Position, shipRadius: number): boolean {
  return Math.floor(Math.hypot(shipPos.x, shipPos.y)) + shipRadius > WORLD.radius;
}

/** Asteroids inhabit the same circular world as ships. */
export function isPoseInAsteroidField(x: number, y: number, slop = 1): boolean {
  return Math.hypot(x, y) <= WORLD.radius + slop;
}

/** First exit from the circular world along a laser's swept segment.
 * Authoritative shots originate inside the world; a local outward muzzle prediction
 * beyond the wall reflects immediately until its shot receipt arrives. */
export function findWorldBoundaryImpact(
  start: Position,
  end: Position
): {
  point: Position;
  normal: Position;
  distance: number;
} | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0 || Math.hypot(end.x, end.y) < WORLD.radius) {
    return null;
  }
  const startRadius = Math.hypot(start.x, start.y);
  const nx = dx / length;
  const ny = dy / length;
  const projection = start.x * nx + start.y * ny;
  const distance =
    startRadius >= WORLD.radius
      ? 0
      : -projection +
        Math.sqrt(
          Math.max(
            0,
            projection * projection + WORLD.radius * WORLD.radius - startRadius * startRadius
          )
        );
  if (distance > length) {
    return null;
  }
  const x = start.x + nx * distance;
  const y = start.y + ny * distance;
  const radius = Math.hypot(x, y);
  const normal = { x: x / radius, y: y / radius };
  return {
    point: { x: normal.x * WORLD.radius, y: normal.y * WORLD.radius },
    normal,
    distance,
  };
}
