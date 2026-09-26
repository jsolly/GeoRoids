import { cruiseVelocity } from '../../../shared/shipFlight';
import type { Position, Velocity } from '../../../shared-types';
import { sampleGradient } from './heightfield';
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

/** Following a contour earns speed in either direction; crossing keeps ordinary cruise. */
export function terrainCruiseVelocity(position: Position, angle: number, cruise: number): Velocity {
  const gradient = travelGradient(position);
  const heading = cruiseVelocity(angle, 1);
  const across = Math.max(-1, Math.min(1, heading.x * gradient.x + heading.y * gradient.y));
  const alignment = 1 - across * across;
  const speed = cruise * (1 + TERRAIN.CONTOUR_SPEED_BONUS * gradient.strength * alignment);
  return { x: heading.x * speed, y: heading.y * speed };
}

/**
 * Heading-independent local ceiling for pose validation and blasts. Free flight
 * remains client-owned: this bounds speed, not contour alignment.
 * Travel/time/world limits remain enforced separately by PlayerMotionService.
 */
export function terrainSpeedLimit(position: Position, cruise: number): number {
  return cruise * (1 + TERRAIN.CONTOUR_SPEED_BONUS * travelGradient(position).strength);
}
