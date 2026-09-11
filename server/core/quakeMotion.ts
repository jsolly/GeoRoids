import type { Position, Velocity } from '../../shared-types';
import { applyQuakeImpulse } from '../../src/entities/ship/quakeImpulse';

/** Knockback is expressed in world units per simulation frame. */
export const QUAKE_KNOCKBACK_DECAY = 0.92;

export interface QuakeMotion {
  offset: Position;
  velocity: Velocity;
}

export function createQuakeMotion(): QuakeMotion {
  return {
    offset: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
  };
}

/** Add the pulse delta to motion that an orbit/update loop owns separately. */
export function applyQuakeMotion(
  body: { position: Position; velocity: Velocity },
  motion: QuakeMotion,
  origin: Position,
  fallbackAngle = 0
): boolean {
  const beforeX = body.velocity.x;
  const beforeY = body.velocity.y;
  if (!applyQuakeImpulse(body, origin, fallbackAngle)) {
    return false;
  }
  motion.velocity.x += body.velocity.x - beforeX;
  motion.velocity.y += body.velocity.y - beforeY;
  return true;
}

/** Advance a pulse through an orbiting body's position, then damp it. */
export function advanceQuakeMotion(motion: QuakeMotion): void {
  motion.offset.x += motion.velocity.x;
  motion.offset.y += motion.velocity.y;
  motion.velocity.x *= QUAKE_KNOCKBACK_DECAY;
  motion.velocity.y *= QUAKE_KNOCKBACK_DECAY;
}

export function clearQuakeMotion(motion: QuakeMotion): void {
  motion.offset.x = 0;
  motion.offset.y = 0;
  motion.velocity.x = 0;
  motion.velocity.y = 0;
}
