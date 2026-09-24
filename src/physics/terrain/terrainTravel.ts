import { cruiseVelocity } from '../../../shared/shipFlight';
import type { Position, Velocity } from '../../../shared-types';
import { sampleGradient } from './heightfield';
import { PASSAGES, passageAlignment, passageStrength } from './passages';
import { TERRAIN } from './terrainConfig';
import { getTerrainField } from './terrainSession';

function travelGradient(position: Position): { x: number; y: number; strength: number } {
  const gradient = sampleGradient(getTerrainField(), position.x, position.y);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  const strength = Math.max(
    0,
    Math.min(
      1,
      (magnitude - TERRAIN.TRAVEL_FLAT_GRADIENT) /
        (TERRAIN.TRAVEL_STEEP_GRADIENT - TERRAIN.TRAVEL_FLAT_GRADIENT)
    )
  );
  return magnitude > 0
    ? { x: gradient.x / magnitude, y: gradient.y / magnitude, strength }
    : { x: 0, y: 0, strength: 0 };
}

/** Nose-relative cruise plus persistent downhill drift across the contours. */
export function terrainCruiseVelocity(position: Position, angle: number, cruise: number): Velocity {
  const gradient = travelGradient(position);
  const alignment = passageAlignment(getTerrainField(), position.x, position.y, angle);
  const heading = cruiseVelocity(angle, 1);
  const uphill = Math.max(-1, Math.min(1, heading.x * gradient.x + heading.y * gradient.y));
  const forward =
    cruise *
    (1 +
      PASSAGES.SPEED_BONUS * alignment +
      gradient.strength *
        (1 - alignment) *
        (TERRAIN.DESCENT_SPEED_BONUS * Math.max(0, -uphill) -
          (1 - TERRAIN.CLIMB_SPEED_FRACTION) * Math.max(0, uphill)));
  const drift = cruise * TERRAIN.CROSS_SLOPE_DRIFT * gradient.strength * (1 - alignment);
  return {
    x: heading.x * forward - (gradient.x - heading.x * uphill) * drift,
    y: heading.y * forward - (gradient.y - heading.y * uphill) * drift,
  };
}

/**
 * Heading-independent local ceiling for pose validation and blasts. Free flight
 * remains client-owned: this bounds speed, not steering or uphill compliance.
 * Travel/time/world limits remain enforced separately by PlayerMotionService.
 */
export function terrainSpeedLimit(position: Position, cruise: number): number {
  const slopeBonus = TERRAIN.DESCENT_SPEED_BONUS * travelGradient(position).strength;
  const strength = passageStrength(getTerrainField(), position.x, position.y);
  return cruise * (1 + slopeBonus + Math.max(0, PASSAGES.SPEED_BONUS - slopeBonus) * strength);
}
