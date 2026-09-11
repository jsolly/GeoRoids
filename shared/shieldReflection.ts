import type { Position } from '../shared-types';
import { reflectVector } from './asteroidReflection';

/** A live circular shield surface in the swept projectile coordinate space. */
export interface ShieldReflectionBody {
  id: string;
  position: Position;
  radius: number;
}

interface ShieldReflectionImpact {
  shieldId: string;
  point: Position;
  /** Unit radial normal pointing away from the shielded ship. */
  normal: Position;
  distance: number;
}

const SHIELD_REFLECTION_LIMITS = {
  coordinate: 10_000_000,
  distance: 1_000_000,
  shields: 256,
} as const;

const EPSILON = 1e-7;

function assertPoint(point: Position): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    Math.abs(point.x) > SHIELD_REFLECTION_LIMITS.coordinate ||
    Math.abs(point.y) > SHIELD_REFLECTION_LIMITS.coordinate
  ) {
    throw new RangeError('Shield reflection coordinates must be finite and bounded');
  }
}

function assertDistance(distance: number): void {
  if (!Number.isFinite(distance) || distance < 0 || distance > SHIELD_REFLECTION_LIMITS.distance) {
    throw new RangeError('Shield reflection distance exceeds the finite tracing limit');
  }
}

function circleImpact(
  start: Position,
  delta: Position,
  distance: number,
  shield: ShieldReflectionBody,
  ignoreOriginShieldId?: string
): ShieldReflectionImpact | null {
  const radius = shield.radius;
  if (!Number.isFinite(radius) || radius <= 0 || radius > SHIELD_REFLECTION_LIMITS.distance) {
    throw new RangeError('Shield reflection radius must be finite and positive');
  }

  const offset = { x: start.x - shield.position.x, y: start.y - shield.position.y };
  const a = delta.x * delta.x + delta.y * delta.y;
  if (a <= EPSILON * EPSILON) {
    const radialLength = Math.hypot(offset.x, offset.y);
    if (radialLength > radius + EPSILON) {
      return null;
    }
    if (ignoreOriginShieldId === shield.id) {
      return null;
    }
    return {
      shieldId: shield.id,
      point: { ...start },
      normal:
        radialLength > EPSILON
          ? { x: offset.x / radialLength, y: offset.y / radialLength }
          : { x: 0, y: -1 },
      distance: 0,
    };
  }
  const b = 2 * (offset.x * delta.x + offset.y * delta.y);
  const c = offset.x * offset.x + offset.y * offset.y - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) {
    return null;
  }

  const root = Math.sqrt(Math.max(0, discriminant));
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  const startsInside = c < -EPSILON;
  const startsOnSurface = Math.abs(c) <= EPSILON;
  const movingInward = offset.x * delta.x + offset.y * delta.y < -EPSILON;
  // A freshly spawned shot can begin inside a friendly shield because its
  // muzzle is outside the hull but inside the larger bubble. Treat an inward
  // path as contacting the shield at its origin so the hull can never win the
  // same swept segment. An outward path keeps the exit contact for callers
  // that need to carry the shot through the bubble before resuming tracing.
  if (startsInside && movingInward) {
    const radialLength = Math.hypot(offset.x, offset.y);
    const direction = { x: delta.x / distance, y: delta.y / distance };
    const normal =
      radialLength > EPSILON
        ? { x: offset.x / radialLength, y: offset.y / radialLength }
        : { x: -direction.x, y: -direction.y };
    if (ignoreOriginShieldId === shield.id) {
      return null;
    }
    return { shieldId: shield.id, point: { ...start }, normal, distance: 0 };
  }
  const candidates = startsInside
    ? [second]
    : startsOnSurface && !movingInward
      ? []
      : [first, second];
  const fraction = candidates.find((value) => value >= -EPSILON && value <= 1 + EPSILON);
  if (fraction === undefined) {
    return null;
  }

  const clampedFraction = Math.max(0, Math.min(1, fraction));
  const hitDistance = distance * clampedFraction;
  if (ignoreOriginShieldId === shield.id && hitDistance <= EPSILON) {
    return null;
  }
  const point = {
    x: start.x + delta.x * clampedFraction,
    y: start.y + delta.y * clampedFraction,
  };
  const radial = { x: point.x - shield.position.x, y: point.y - shield.position.y };
  const radialLength = Math.hypot(radial.x, radial.y);
  const direction = { x: delta.x / distance, y: delta.y / distance };
  const normal =
    radialLength > EPSILON
      ? { x: radial.x / radialLength, y: radial.y / radialLength }
      : { x: -direction.x, y: -direction.y };
  return { shieldId: shield.id, point, normal, distance: hitDistance };
}

/** Find the first swept contact with any live circular shield. */
export function findNearestShieldImpact(
  start: Position,
  end: Position,
  shields: readonly ShieldReflectionBody[],
  ignoreOriginShieldId?: string
): ShieldReflectionImpact | null {
  assertPoint(start);
  assertPoint(end);
  if (shields.length > SHIELD_REFLECTION_LIMITS.shields) {
    throw new RangeError('Shield reflection surface count exceeds the tracing limit');
  }
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const distance = Math.hypot(delta.x, delta.y);
  assertDistance(distance);
  const ids = new Set<string>();
  let nearest: ShieldReflectionImpact | null = null;
  for (const shield of shields) {
    if (!shield.id || ids.has(shield.id)) {
      throw new RangeError('Shield reflection surfaces require unique nonempty IDs');
    }
    ids.add(shield.id);
    assertPoint(shield.position);
    const impact = circleImpact(start, delta, distance, shield, ignoreOriginShieldId);
    if (
      impact &&
      (!nearest ||
        impact.distance < nearest.distance - EPSILON ||
        (Math.abs(impact.distance - nearest.distance) <= EPSILON &&
          impact.shieldId < nearest.shieldId))
    ) {
      nearest = impact;
    }
  }
  return nearest;
}

/** Reflect a projectile velocity without changing its magnitude. */
export function reflectProjectileVelocity(velocity: Position, outwardNormal: Position): Position {
  return reflectVector(velocity, outwardNormal);
}
