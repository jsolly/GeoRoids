import type { AsteroidData, Position } from '../shared-types';

export type ReflectionAsteroid = Pick<
  AsteroidData,
  'id' | 'position' | 'size' | 'rotation' | 'vertices' | 'offsets'
>;

/** Invalid/excessive geometry fails before tracing; never omit a nearer obstacle. */
export const REFLECTION_LIMITS = {
  coordinate: 10_000_000,
  distance: 1_000_000,
  vertices: 64,
  asteroids: 512,
  bounces: 32,
} as const;

const EPSILON = 1e-7;
const CORNER_PROBE = EPSILON * 32;

interface AsteroidImpact {
  asteroidId: string;
  point: Position;
  /** Unit outward normal; an exact vertex uses the adjacent-face bisector. */
  normal: Position;
  edgeIndex: number;
  distance: number;
}

export interface ReflectionPreview {
  segments: Array<{ start: Position; end: Position; asteroidId?: string }>;
  impacts: AsteroidImpact[];
  finalDirection: Position;
  traveledDistance: number;
  termination: 'distance' | 'bounce-limit' | 'blocked' | 'stationary';
}

interface ReflectionPreviewOptions {
  maxDistance: number;
  /** Maximum reflections, not hits: the following hit ends the preview. */
  maxBounces: number;
  /** Include all physical obstacles; return false for an absorbing surface. */
  canReflect?: (asteroid: ReflectionAsteroid) => boolean;
}

interface PreparedAsteroid {
  asteroid: ReflectionAsteroid;
  points: Position[];
}

function assertPoint(point: Position): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    Math.abs(point.x) > REFLECTION_LIMITS.coordinate ||
    Math.abs(point.y) > REFLECTION_LIMITS.coordinate
  ) {
    throw new RangeError('Reflection coordinates must be finite and within world limits');
  }
}

function assertDistance(distance: number): void {
  if (!Number.isFinite(distance) || distance < 0 || distance > REFLECTION_LIMITS.distance) {
    throw new RangeError('Reflection distance exceeds the finite tracing limit');
  }
}

function cross(a: Position, b: Position): number {
  return a.x * b.y - a.y * b.x;
}

function subtract(a: Position, b: Position): Position {
  return { x: a.x - b.x, y: a.y - b.y };
}

function advance(start: Position, direction: Position, distance: number): Position {
  return { x: start.x + direction.x * distance, y: start.y + direction.y * distance };
}

/** Same outer-contour math as vectorJuice.polygonPoints; no client/Canvas dependency. */
export function asteroidPolygonPoints(asteroid: ReflectionAsteroid): Position[] {
  assertPoint(asteroid.position);
  if (
    !Number.isFinite(asteroid.size) ||
    asteroid.size <= 0 ||
    asteroid.size > REFLECTION_LIMITS.distance ||
    !Number.isFinite(asteroid.rotation) ||
    !Number.isInteger(asteroid.vertices) ||
    asteroid.vertices < 3 ||
    asteroid.vertices > REFLECTION_LIMITS.vertices ||
    asteroid.offsets.length > REFLECTION_LIMITS.vertices
  ) {
    throw new RangeError('Invalid reflection asteroid contour');
  }
  const points: Position[] = [];
  for (let index = 0; index < asteroid.vertices; index += 1) {
    const offset = asteroid.offsets[index] ?? 1;
    if (!Number.isFinite(offset) || offset < 0 || offset > 4) {
      throw new RangeError('Invalid reflection asteroid radial offset');
    }
    const angle = asteroid.rotation + (index * Math.PI * 2) / asteroid.vertices;
    const point = {
      x: asteroid.position.x + asteroid.size * offset * Math.cos(angle),
      y: asteroid.position.y + asteroid.size * offset * Math.sin(angle),
    };
    assertPoint(point);
    points.push(point);
  }
  // Radial vertices have counterclockwise winding. A zero-area contour cannot
  // define a reflecting interior; reject it instead of manufacturing a normal.
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (a && b) {
      twiceArea += cross(subtract(a, asteroid.position), subtract(b, asteroid.position));
    }
  }
  if (twiceArea <= EPSILON * EPSILON) {
    throw new RangeError('Reflection asteroid has no polygon interior');
  }
  return points;
}

function prepare(asteroids: readonly ReflectionAsteroid[]): PreparedAsteroid[] {
  if (asteroids.length > REFLECTION_LIMITS.asteroids) {
    throw new RangeError('Reflection obstacle count exceeds the tracing limit');
  }
  const ids = new Set<string>();
  return asteroids.map((asteroid) => {
    if (!asteroid.id || ids.has(asteroid.id)) {
      throw new RangeError('Reflection obstacles require unique nonempty IDs');
    }
    ids.add(asteroid.id);
    return { asteroid, points: asteroidPolygonPoints(asteroid) };
  });
}

/** -1 outside, 0 on the boundary, 1 inside (including concave radial contours). */
function containment(point: Position, polygon: readonly Position[]): number {
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (!a || !b) {
      continue;
    }
    const edge = subtract(b, a);
    const relative = subtract(point, a);
    const length = Math.hypot(edge.x, edge.y);
    if (length <= EPSILON) {
      continue;
    }
    const along = (relative.x * edge.x + relative.y * edge.y) / length;
    if (
      Math.abs(cross(edge, relative)) / length <= EPSILON &&
      along >= -EPSILON &&
      along <= length + EPSILON
    ) {
      return 0;
    }
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function polygonImpact(
  start: Position,
  direction: Position,
  maxDistance: number,
  prepared: PreparedAsteroid,
  ignoreOriginAsteroidId?: string
): AsteroidImpact | null {
  let closest: AsteroidImpact | null = null;
  const normalSum = { x: 0, y: 0 };
  const { asteroid, points } = prepared;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (!a || !b) {
      continue;
    }
    const edge = subtract(b, a);
    const length = Math.hypot(edge.x, edge.y);
    const denominator = cross(direction, edge);
    if (length <= EPSILON || Math.abs(denominator) <= Number.EPSILON * 16 * length) {
      continue; // Parallel/collinear grazing does not enter the polygon.
    }
    const relative = subtract(a, start);
    const distance = cross(relative, edge) / denominator;
    const along = cross(relative, direction) / denominator;
    if (
      distance < -EPSILON ||
      distance > maxDistance + EPSILON ||
      along < -EPSILON / length ||
      along > 1 + EPSILON / length ||
      (asteroid.id === ignoreOriginAsteroidId && distance <= EPSILON)
    ) {
      continue;
    }
    const clampedDistance = Math.max(0, Math.min(maxDistance, distance));
    const point = advance(start, direction, clampedDistance);
    if (along * length <= EPSILON || (1 - along) * length <= EPSILON) {
      const before = containment(advance(point, direction, -CORNER_PROBE), points);
      const after = containment(advance(point, direction, CORNER_PROBE), points);
      if (before === after || before === 0 || after === 0) {
        continue; // A vertex touch/edge graze without entering or exiting.
      }
    }
    const normal = { x: edge.y / length, y: -edge.x / length };
    if (clampedDistance <= EPSILON && direction.x * normal.x + direction.y * normal.y >= 0) {
      continue; // Departing from a surface is not a new impact.
    }
    if (!closest || clampedDistance < closest.distance - EPSILON) {
      closest = {
        asteroidId: asteroid.id,
        point,
        normal,
        edgeIndex: index,
        distance: clampedDistance,
      };
      normalSum.x = normal.x;
      normalSum.y = normal.y;
    } else if (Math.abs(clampedDistance - closest.distance) <= EPSILON) {
      normalSum.x += normal.x;
      normalSum.y += normal.y;
    }
  }
  if (closest) {
    const length = Math.hypot(normalSum.x, normalSum.y);
    if (length > EPSILON) {
      closest.normal = { x: normalSum.x / length, y: normalSum.y / length };
    }
  }
  return closest;
}

function nearestImpact(
  start: Position,
  direction: Position,
  distance: number,
  asteroids: readonly PreparedAsteroid[],
  ignoreOriginAsteroidId?: string
): AsteroidImpact | null {
  let nearest: AsteroidImpact | null = null;
  for (const asteroid of asteroids) {
    const hit = polygonImpact(start, direction, distance, asteroid, ignoreOriginAsteroidId);
    if (
      hit &&
      (!nearest ||
        hit.distance < nearest.distance - EPSILON ||
        (Math.abs(hit.distance - nearest.distance) <= EPSILON &&
          hit.asteroidId < nearest.asteroidId))
    ) {
      nearest = hit;
    }
  }
  return nearest;
}

/** Swept point-laser collision; starting inside returns the first exit surface. */
export function findNearestAsteroidImpact(
  start: Position,
  end: Position,
  asteroids: readonly ReflectionAsteroid[],
  ignoreOriginAsteroidId?: string
): AsteroidImpact | null {
  assertPoint(start);
  assertPoint(end);
  const delta = subtract(end, start);
  const distance = Math.hypot(delta.x, delta.y);
  assertDistance(distance);
  const prepared = prepare(asteroids);
  if (distance <= EPSILON) {
    return null;
  }
  return nearestImpact(
    start,
    { x: delta.x / distance, y: delta.y / distance },
    distance,
    prepared,
    ignoreOriginAsteroidId
  );
}

/** Pure specular reflection retains vector magnitude; energy upgrades belong to gameplay. */
export function reflectVector(vector: Position, outwardNormal: Position): Position {
  assertPoint(vector);
  assertPoint(outwardNormal);
  const length = Math.hypot(outwardNormal.x, outwardNormal.y);
  if (length <= EPSILON) {
    throw new RangeError('A reflection requires a nonzero surface normal');
  }
  const nx = outwardNormal.x / length;
  const ny = outwardNormal.y / length;
  const projection = vector.x * nx + vector.y * ny;
  return { x: vector.x - 2 * projection * nx, y: vector.y - 2 * projection * ny };
}

/** Bounded frozen-world sight geometry, suitable for the same server collision step.
 * No energy/damage policy is inferred. Distances include every leg with no epsilon
 * teleport: only the immediately previous polygon's zero-distance recontact is ignored.
 */
export function previewAsteroidReflections(
  start: Position,
  direction: Position,
  asteroids: readonly ReflectionAsteroid[],
  options: ReflectionPreviewOptions
): ReflectionPreview {
  assertPoint(start);
  assertPoint(direction);
  assertDistance(options.maxDistance);
  if (
    !Number.isInteger(options.maxBounces) ||
    options.maxBounces < 0 ||
    options.maxBounces > REFLECTION_LIMITS.bounces
  ) {
    throw new RangeError('Reflection bounce count exceeds the tracing limit');
  }
  const prepared = prepare(asteroids);
  const length = Math.hypot(direction.x, direction.y);
  const result: ReflectionPreview = {
    segments: [],
    impacts: [],
    finalDirection:
      length > EPSILON ? { x: direction.x / length, y: direction.y / length } : { x: 0, y: 0 },
    traveledDistance: 0,
    termination: length <= EPSILON ? 'stationary' : 'distance',
  };
  if (length <= EPSILON) {
    return result;
  }
  let origin = { ...start };
  let previousId: string | undefined;
  let bounces = 0;
  while (result.traveledDistance < options.maxDistance) {
    const remaining = options.maxDistance - result.traveledDistance;
    const hit = nearestImpact(origin, result.finalDirection, remaining, prepared, previousId);
    const end = hit?.point ?? advance(origin, result.finalDirection, remaining);
    assertPoint(end);
    result.segments.push({ start: origin, end, ...(hit ? { asteroidId: hit.asteroidId } : {}) });
    result.traveledDistance += hit?.distance ?? remaining;
    if (!hit) {
      break;
    }
    result.impacts.push(hit);
    const obstacle = prepared.find((entry) => entry.asteroid.id === hit.asteroidId);
    if (obstacle && options.canReflect && !options.canReflect(obstacle.asteroid)) {
      result.termination = 'blocked';
      break;
    }
    if (bounces >= options.maxBounces) {
      result.termination = 'bounce-limit';
      break;
    }
    result.finalDirection = reflectVector(result.finalDirection, hit.normal);
    origin = end;
    previousId = hit.asteroidId;
    bounces += 1;
  }
  return result;
}
