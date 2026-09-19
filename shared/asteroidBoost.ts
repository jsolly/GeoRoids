import type { AsteroidBoost, Velocity } from '../shared-types';

/** Velocity uses world units per fixed 60 Hz simulation tick. */
export const ASTEROID_BOOST = {
  burnFrames: 180,
  acceleration: 0.025,
  maxSpeed: 2.5,
} as const;

/** Both server motion and client dead reckoning use the same finite burn. */
export function tickAsteroidBoost(body: {
  boost?: AsteroidBoost | null;
  velocity: Velocity;
}): void {
  const boost = body.boost;
  if (boost?.phase !== 'burning') {
    return;
  }
  body.velocity.x += Math.cos(boost.angle) * ASTEROID_BOOST.acceleration;
  body.velocity.y -= Math.sin(boost.angle) * ASTEROID_BOOST.acceleration;
  const speed = Math.hypot(body.velocity.x, body.velocity.y);
  if (speed > ASTEROID_BOOST.maxSpeed) {
    body.velocity.x *= ASTEROID_BOOST.maxSpeed / speed;
    body.velocity.y *= ASTEROID_BOOST.maxSpeed / speed;
  }
  boost.remainingFrames -= 1;
  if (boost.remainingFrames <= 0) {
    body.boost = null;
  }
}
