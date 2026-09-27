import type { ContourLockState, Position, Velocity } from '../shared-types';
import { sampleGradient, sampleHeight } from '../src/physics/terrain/heightfield';
import { TERRAIN } from '../src/physics/terrain/terrainConfig';
import { getTerrainField } from '../src/physics/terrain/terrainSession';

export const CONTOUR_LOCK = {
  captureRadius: 48,
  railTolerance: 6,
  acquisitionMs: 600,
  speedMultiplier: 1.2,
  minimumGradient: TERRAIN.TRAVEL_FLAT_GRADIENT,
} as const;

export function isContourLockState(value: unknown): value is ContourLockState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).every((key) => key === 'height' || key === 'direction') &&
    'height' in value &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height) &&
    Math.abs(value.height) <= 1 + TERRAIN.LANDMARK_COUNT * TERRAIN.LANDMARK_AMP &&
    Math.abs(
      value.height / TERRAIN.CONTOUR_INTERVAL - Math.round(value.height / TERRAIN.CONTOUR_INTERVAL)
    ) < 1e-9 &&
    'direction' in value &&
    (value.direction === 1 || value.direction === -1)
  );
}

export function contourLockSpeed(cruise: number): number {
  return cruise * (1 + TERRAIN.CONTOUR_SPEED_BONUS) * CONTOUR_LOCK.speedMultiplier;
}

/** Local normal distance to the selected level; flat ground cannot supply a rail. */
export function contourLockDistance(position: Position, state: ContourLockState): number {
  const field = getTerrainField();
  const gradient = sampleGradient(field, position.x, position.y);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  return magnitude > CONTOUR_LOCK.minimumGradient
    ? Math.abs(sampleHeight(field, position.x, position.y) - state.height) / magnitude
    : Infinity;
}

/** Constant-work guidance onto and along one analytic contour, without teleporting. */
export function contourLockVelocity(
  position: Position,
  state: ContourLockState,
  cruise: number
): Velocity | null {
  const field = getTerrainField();
  const gradient = sampleGradient(field, position.x, position.y);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  if (magnitude <= CONTOUR_LOCK.minimumGradient) {
    return null;
  }
  const distance = (state.height - sampleHeight(field, position.x, position.y)) / magnitude;
  if (Math.abs(distance) > CONTOUR_LOCK.captureRadius) {
    return null;
  }
  const speed = contourLockSpeed(cruise);
  const normal = Math.max(-speed * 0.75, Math.min(speed * 0.75, distance * 0.25));
  const tangent = Math.sqrt(speed * speed - normal * normal) * state.direction;
  return {
    x: (-gradient.y * tangent + gradient.x * normal) / magnitude,
    y: (gradient.x * tangent + gradient.y * normal) / magnitude,
  };
}
