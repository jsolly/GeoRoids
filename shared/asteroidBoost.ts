import type { AsteroidBoost, Position, Velocity } from '../shared-types';
import { nearestFurnace } from './furnaces';

/** Velocity uses world units per fixed 60 Hz simulation tick. */
export const ASTEROID_BOOST = {
  acceleration: 0.025,
  maxSpeed: 2.5,
} as const;

export function furnaceHeading(position: Position): number {
  const target = nearestFurnace(position).position;
  return Math.atan2(position.y - target.y, target.x - position.x);
}

/** Shared guidance keeps authoritative motion and client prediction in agreement. */
export function tickAsteroidBoost(body: {
  boost?: AsteroidBoost | null;
  position: Position;
  velocity: Velocity;
}): void {
  const boost = body.boost;
  if (!boost) {
    return;
  }
  const target = nearestFurnace(body.position).position;
  const dx = target.x - body.position.x;
  const dy = target.y - body.position.y;
  const distance = Math.hypot(dx, dy);
  boost.angle = Math.atan2(body.position.y - target.y, dx);
  if (boost.phase !== 'burning') {
    return;
  }
  // Seek a velocity, rather than adding radial thrust forever: this cancels
  // sideways momentum from impacts instead of orbiting the intake indefinitely.
  const scale = distance > 0 ? Math.min(ASTEROID_BOOST.maxSpeed / distance, 1 / 60) : 0;
  const changeX = dx * scale - body.velocity.x;
  const changeY = dy * scale - body.velocity.y;
  const change = Math.hypot(changeX, changeY);
  const fraction = change > 0 ? Math.min(1, ASTEROID_BOOST.acceleration / change) : 0;
  body.velocity.x += changeX * fraction;
  body.velocity.y += changeY * fraction;
  const speed = Math.hypot(body.velocity.x, body.velocity.y);
  if (speed > ASTEROID_BOOST.maxSpeed) {
    body.velocity.x *= ASTEROID_BOOST.maxSpeed / speed;
    body.velocity.y *= ASTEROID_BOOST.maxSpeed / speed;
  }
}
