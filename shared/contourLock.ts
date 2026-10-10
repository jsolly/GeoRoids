import type { ContourLockState, Position, Velocity } from '../shared-types';
import { GAME } from '../src/constants';
import { sampleGradient, sampleHeight } from '../src/physics/terrain/heightfield';
import { TERRAIN } from '../src/physics/terrain/terrainConfig';
import { getTerrainField } from '../src/physics/terrain/terrainSession';

/** Geometry for server rail validation; unavailable distance is explicit null. */
export function contourLockGeometry(position: Position, state: ContourLockState) {
  const field = getTerrainField();
  const gradient = sampleGradient(field, position.x, position.y, 0.25);
  const gradientMagnitude = Math.hypot(gradient.x, gradient.y);
  const height = sampleHeight(field, position.x, position.y);
  return {
    height,
    gradientMagnitude,
    distance:
      gradientMagnitude > CONTOUR_LOCK.minimumGradient
        ? Math.abs(height - state.height) / gradientMagnitude
        : null,
  };
}

export const CONTOUR_LOCK = {
  captureRadius: 48,
  hopRadius: 64,
  railTolerance: 6,
  acquisitionMs: 800,
  speedMultiplier: 1.2,
  // A locked rail remains usable through shallow bends; ordinary terrain boost
  // thresholds describe speed bonuses, not whether a contour exists.
  minimumGradient: 1e-8,
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
  const gradient = sampleGradient(field, position.x, position.y, 0.25);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  return magnitude > CONTOUR_LOCK.minimumGradient
    ? Math.abs(sampleHeight(field, position.x, position.y) - state.height) / magnitude
    : Infinity;
}

/** Local direction field; guidance needs a finer derivative than ordinary terrain boost. */
function contourDirection(
  position: Position,
  state: ContourLockState,
  speed: number
): Velocity | null {
  const field = getTerrainField();
  const gradient = sampleGradient(field, position.x, position.y, 0.25);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  if (magnitude <= CONTOUR_LOCK.minimumGradient) {
    return null;
  }
  const distance = (state.height - sampleHeight(field, position.x, position.y)) / magnitude;
  if (Math.abs(distance) > CONTOUR_LOCK.hopRadius) {
    return null;
  }
  const normal = Math.max(-speed * 0.75, Math.min(speed * 0.75, distance * 0.25));
  const tangent = Math.sqrt(speed * speed - normal * normal) * state.direction;
  return {
    x: (-gradient.y * tangent + gradient.x * normal) / magnitude,
    y: (gradient.x * tangent + gradient.y * normal) / magnitude,
  };
}

/** Integrate the bend in bounded substeps; return the actual displacement as velocity. */
function contourStep(position: Position, state: ContourLockState, speed: number): Velocity | null {
  const steps = Math.min(16, Math.max(1, Math.ceil(speed)));
  const dt = 1 / steps;
  let cursor = { ...position };
  for (let step = 0; step < steps; step++) {
    const first = contourDirection(cursor, state, speed);
    if (!first) {
      return null;
    }
    const middle = contourDirection(
      { x: cursor.x + (first.x * dt) / 2, y: cursor.y + (first.y * dt) / 2 },
      state,
      speed
    );
    if (!middle) {
      return null;
    }
    cursor = { x: cursor.x + middle.x * dt, y: cursor.y + middle.y * dt };
  }
  const dx = cursor.x - position.x;
  const dy = cursor.y - position.y;
  const length = Math.hypot(dx, dy);
  // Keep the flight speed contract while using the integrated chord's heading.
  return length > 0 ? { x: (dx * speed) / length, y: (dy * speed) / length } : { x: 0, y: 0 };
}

/** Shared curved movement for live flight, previews and authoritative route validation. */
export function contourLockVelocity(
  position: Position,
  state: ContourLockState,
  cruise: number
): Velocity | null {
  return contourStep(position, state, contourLockSpeed(cruise));
}

/** A settled pilot may reverse on the current rail or catch one adjacent level. */
export function canHopContour(
  position: Position,
  previous: ContourLockState,
  candidate: ContourLockState
): boolean {
  return (
    ((previous.height === candidate.height && previous.direction !== candidate.direction) ||
      Math.abs(Math.abs(previous.height - candidate.height) - TERRAIN.CONTOUR_INTERVAL) < 1e-9) &&
    contourLockDistance(position, previous) <= CONTOUR_LOCK.railTolerance &&
    contourLockDistance(position, candidate) <= CONTOUR_LOCK.hopRadius
  );
}

/** The same accelerated guidance drives both live flight and a bounded hop preview. */
export function acceleratedContourVelocity(
  position: Position,
  state: ContourLockState,
  cruise: number,
  speed: number,
  acceleration: number
): Velocity | null {
  const targetSpeed = contourLockSpeed(cruise);
  const actualSpeed = Math.min(targetSpeed, speed + (acceleration * targetSpeed) / cruise);
  return contourStep(position, state, actualSpeed);
}

/** Refuse a line whose intervening bend or flat patch would drop guidance mid-glide. */
export function canReachContour(
  position: Position,
  state: ContourLockState,
  cruise: number,
  speed: number,
  acceleration: number
): boolean {
  let cursor = { ...position };
  let currentSpeed = speed;
  for (let frame = 0; frame < Math.ceil((CONTOUR_LOCK.acquisitionMs * GAME.FPS) / 1000); frame++) {
    const velocity = acceleratedContourVelocity(cursor, state, cruise, currentSpeed, acceleration);
    if (!velocity) {
      return false;
    }
    cursor = { x: cursor.x + velocity.x, y: cursor.y + velocity.y };
    currentSpeed = Math.hypot(velocity.x, velocity.y);
    if (contourLockDistance(cursor, state) <= CONTOUR_LOCK.railTolerance) {
      return true;
    }
  }
  return false;
}
