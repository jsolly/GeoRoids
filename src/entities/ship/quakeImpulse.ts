import type { Position, Velocity } from '../../../shared-types';
import { SHIP_ABILITY } from './shipKits';

/** An outward blast cancels inward momentum before adding its radial kick. */
export function applyQuakeImpulse(
  body: { position: Position; velocity: Velocity },
  origin: Position,
  fallbackAngle = 0
): boolean {
  const dx = body.position.x - origin.x;
  const dy = body.position.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > SHIP_ABILITY.SHOCK_RADIUS) {
    return false;
  }
  const nx = distance > 0 ? dx / distance : Math.cos(fallbackAngle);
  const ny = distance > 0 ? dy / distance : -Math.sin(fallbackAngle);
  const falloff =
    1 - ((1 - SHIP_ABILITY.SHOCK_EDGE_FORCE_RATIO) * distance) / SHIP_ABILITY.SHOCK_RADIUS;
  const inward = Math.min(0, body.velocity.x * nx + body.velocity.y * ny);
  const kick = SHIP_ABILITY.SHOCK_FORCE * falloff - inward;
  body.velocity.x += nx * kick;
  body.velocity.y += ny * kick;
  return true;
}
