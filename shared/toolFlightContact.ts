import type { AsteroidData, Position, ToolTargetPose } from '../shared-types';
import { asteroidPolygonPoints, findNearestAsteroidImpact } from './asteroidReflection';
import { findWorldBoundaryImpact } from './worldBoundary';

/** Shift the shot's origin into the target's end-of-frame coordinates. */
export function relativeFlightStart(
  start: Position,
  current: Position,
  previous: Position
): Position {
  return { x: start.x + current.x - previous.x, y: start.y + current.y - previous.y };
}

function cross(a: Position, b: Position): number {
  return a.x * b.y - a.y * b.x;
}
function difference(a: Position, b: Position): Position {
  return { x: a.x - b.x, y: a.y - b.y };
}
function at(start: Position, end: Position, fraction: number): Position {
  return { x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction };
}

/** Contact between a traveling point and an edge whose endpoints move linearly. */
function movingEdgeContact(
  start: Position,
  end: Position,
  a: Position,
  b: Position,
  nextA: Position,
  nextB: Position
): number | undefined {
  const u = difference(start, a);
  const du = difference(difference(end, start), difference(nextA, a));
  const v = difference(b, a);
  const dv = difference(difference(nextB, nextA), v);
  const c0 = cross(u, v);
  const c1 = cross(du, v) + cross(u, dv);
  const c2 = cross(du, dv);
  const roots: number[] = [];
  if (Math.abs(c2) < 1e-9) {
    if (Math.abs(c1) > 1e-9) {
      roots.push(-c0 / c1);
    }
  } else {
    const discriminant = c1 * c1 - 4 * c2 * c0;
    if (discriminant >= 0) {
      const sqrt = Math.sqrt(discriminant);
      roots.push((-c1 - sqrt) / (2 * c2), (-c1 + sqrt) / (2 * c2));
    }
  }
  let nearest: number | undefined;
  for (const fraction of roots) {
    if (fraction < 0 || fraction > 1) {
      continue;
    }
    const edgeA = at(a, nextA, fraction);
    const edgeB = at(b, nextB, fraction);
    const point = at(start, end, fraction);
    const edge = difference(edgeB, edgeA);
    const offset = difference(point, edgeA);
    const length2 = edge.x * edge.x + edge.y * edge.y;
    const along = length2 > 0 ? (offset.x * edge.x + offset.y * edge.y) / length2 : -1;
    if (along >= 0 && along <= 1 && (nearest === undefined || fraction < nearest)) {
      nearest = fraction;
    }
  }
  return nearest;
}

export function movingAsteroidContact(
  start: Position,
  end: Position,
  asteroid: Pick<AsteroidData, 'id' | 'position' | 'size' | 'rotation' | 'vertices' | 'offsets'>,
  previous: ToolTargetPose = asteroid.position
): number | undefined {
  const relativeStart = relativeFlightStart(start, asteroid.position, previous);
  const delta = Math.atan2(
    Math.sin(asteroid.rotation - (previous.rotation ?? asteroid.rotation)),
    Math.cos(asteroid.rotation - (previous.rotation ?? asteroid.rotation))
  );
  if (Math.abs(delta) < 1e-9) {
    const length = Math.hypot(end.x - relativeStart.x, end.y - relativeStart.y);
    const impact = findNearestAsteroidImpact(relativeStart, end, [asteroid]);
    return impact && length > 0 ? impact.distance / length : undefined;
  }
  // Sweep moving contour edges. Small angular slices bound the arc-to-chord error.
  const steps = Math.min(64, Math.max(1, Math.ceil(Math.abs(delta) / 0.025)));
  const rotation = asteroid.rotation - delta;
  let points = asteroidPolygonPoints({ ...asteroid, rotation });
  for (let step = 0; step < steps; step++) {
    const next = asteroidPolygonPoints({
      ...asteroid,
      rotation: rotation + (delta * (step + 1)) / steps,
    });
    const from = at(relativeStart, end, step / steps);
    const to = at(relativeStart, end, (step + 1) / steps);
    let hit: number | undefined;
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length],
        nextA = next[i],
        nextB = next[(i + 1) % next.length];
      if (!a || !b || !nextA || !nextB) {
        continue;
      }
      const fraction = movingEdgeContact(from, to, a, b, nextA, nextB);
      if (fraction !== undefined && (hit === undefined || fraction < hit)) {
        hit = fraction;
      }
    }
    if (hit !== undefined) {
      return (step + hit) / steps;
    }
    points = next;
  }
  return undefined;
}

/** Choose the first contact; the world wall wins a tie with a hull. */
export function firstToolFlightContact<T>(
  start: Position,
  end: Position,
  bodies: readonly T[],
  contactFraction: (body: T) => number | undefined
):
  | { kind: 'body'; body: T; fraction: number; point: Position }
  | { kind: 'boundary'; point: Position }
  | undefined {
  let hit: { body: T; fraction: number } | undefined;
  for (const body of bodies) {
    const fraction = contactFraction(body);
    if (fraction !== undefined && (!hit || fraction < hit.fraction)) {
      hit = { body, fraction };
    }
  }
  const boundary = findWorldBoundaryImpact(start, end);
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (boundary && (!hit || boundary.distance <= hit.fraction * length)) {
    return { kind: 'boundary', point: boundary.point };
  }
  return hit ? { kind: 'body', ...hit, point: at(start, end, hit.fraction) } : undefined;
}
