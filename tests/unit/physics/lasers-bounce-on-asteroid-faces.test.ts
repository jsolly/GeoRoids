import { describe, expect, it } from 'vitest';
import {
  asteroidPolygonPoints,
  findNearestAsteroidImpact,
  previewAsteroidReflections,
  REFLECTION_LIMITS,
  reflectVector,
  type ReflectionAsteroid,
} from '../../../shared/asteroidReflection';
import { polygonPoints } from '../../../src/rendering/vectorJuice';

const point = (x: number, y: number) => ({ x, y });

/** Four radial vertices give the exact axis-aligned square [-1,1]². */
function square(id = 'square', x = 0, y = 0): ReflectionAsteroid {
  return {
    id,
    position: point(x, y),
    size: Math.SQRT2,
    rotation: Math.PI / 4,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

describe('pilots plan laser bounces on the actual asteroid faces', () => {
  it('uses the same translated, rotated, uneven contour that the canvas strokes', () => {
    const rock = {
      ...square(),
      position: point(52, -18),
      size: 23,
      rotation: 0.731,
      vertices: 7,
      offsets: [0.9, 0.7, 1.1, 0.8],
    };
    expect(asteroidPolygonPoints(rock)).toEqual(polygonPoints(52, -18, 23, 0.731, 7, rock.offsets));
    expect(asteroidPolygonPoints({ ...square(), offsets: [] })).toEqual(
      asteroidPolygonPoints(square())
    );
  });

  it('sweeps through the nearest flat face instead of the circumcircle', () => {
    const hit = findNearestAsteroidImpact(point(-10, 0.3), point(10, 0.3), [square()]);
    expect(hit?.point.x).toBeCloseTo(-1, 10);
    expect(hit?.point.y).toBeCloseTo(0.3, 10);
    expect(hit?.distance).toBeCloseTo(9, 10);
    expect(hit?.normal.x).toBeCloseTo(-1, 10);
    expect(hit?.normal.y).toBeCloseTo(0, 10);
  });

  it('reflects on a rotated face with the analytic normal and keeps speed unchanged', () => {
    const diamond = { ...square(), rotation: 0, size: 2 };
    const hit = findNearestAsteroidImpact(point(-4, 1), point(4, 1), [diamond]);
    expect(hit?.point.x).toBeCloseTo(-1, 10);
    expect(hit?.normal.x).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(hit?.normal.y).toBeCloseTo(Math.SQRT1_2, 10);
    const reflected = reflectVector(point(7, 0), hit?.normal ?? point(0, 0));
    expect(reflected.x).toBeCloseTo(0, 10);
    expect(reflected.y).toBeCloseTo(7, 10);
    expect(Math.hypot(reflected.x, reflected.y)).toBeCloseTo(7, 10);
  });

  it('uses a deterministic corner bisector when both adjacent faces are hit together', () => {
    const hit = findNearestAsteroidImpact(point(-3, -3), point(0, 0), [square()]);
    expect(hit?.point.x).toBeCloseTo(-1, 10);
    expect(hit?.point.y).toBeCloseTo(-1, 10);
    expect(hit?.normal.x).toBeCloseTo(-Math.SQRT1_2, 10);
    expect(hit?.normal.y).toBeCloseTo(-Math.SQRT1_2, 10);
    const bounced = reflectVector(point(1, 1), hit?.normal ?? point(0, 0));
    expect(bounced.x).toBeCloseTo(-1, 10);
    expect(bounced.y).toBeCloseTo(-1, 10);
  });

  it('finds an exit when a projectile starts inside, then reflects back into the contour', () => {
    const hit = findNearestAsteroidImpact(point(0, 0), point(3, 0), [square()]);
    expect(hit?.distance).toBeCloseTo(1, 10);
    expect(hit?.normal.x).toBeCloseTo(1, 10);
    const path = previewAsteroidReflections(point(0, 0), point(1, 0), [square()], {
      maxDistance: 6,
      maxBounces: 2,
    });
    expect(path.impacts.map((impact) => impact.point.x)).toEqual([
      expect.closeTo(1, 9),
      expect.closeTo(-1, 9),
      expect.closeTo(1, 9),
    ]);
    expect(path.traveledDistance).toBeCloseTo(5, 9);
    expect(path.termination).toBe('bounce-limit');
  });

  it('does not turn a parallel edge graze or tangent corner touch into a ricochet', () => {
    expect(findNearestAsteroidImpact(point(-3, 1), point(3, 1), [square()])).toBeNull();
    expect(findNearestAsteroidImpact(point(-3, 3), point(3, 3), [square()])).toBeNull();
    const diamond = { ...square(), rotation: 0, size: 2 };
    expect(findNearestAsteroidImpact(point(-3, 2), point(3, 2), [diamond])).toBeNull();
    expect(findNearestAsteroidImpact(point(-3, 0), point(-3, 0), [square()])).toBeNull();
  });

  it('still detects a very shallow real crossing rather than treating it as parallel', () => {
    const hit = findNearestAsteroidImpact(point(-500_000, 1.000005), point(500_000, 0.999995), [
      square(),
    ]);
    expect(hit?.point.x).toBeCloseTo(0, 3);
    expect(hit?.point.y).toBeCloseTo(1, 9);
    expect(hit?.normal.y).toBeCloseTo(1, 9);
  });

  it('accepts a surface entry but does not immediately rehit a departing surface', () => {
    expect(findNearestAsteroidImpact(point(-1, 0), point(-3, 0), [square()])).toBeNull();
    expect(findNearestAsteroidImpact(point(-1, 0), point(0, 0), [square()])?.distance).toBe(0);
    const path = previewAsteroidReflections(point(-3, 0), point(1, 0), [square()], {
      maxDistance: 10,
      maxBounces: 20,
    });
    expect(path.impacts).toHaveLength(1);
    expect(path.segments).toHaveLength(2);
    expect(path.segments[1]?.end.x).toBeCloseTo(-9, 9);
    expect(path.traveledDistance).toBeCloseTo(10, 9);
  });

  it('hits the nearer physical rock regardless of array order, with stable exact-overlap ties', () => {
    const near = square('near');
    const far = square('far', 5);
    for (const rocks of [
      [far, near],
      [near, far],
    ]) {
      expect(findNearestAsteroidImpact(point(-4, 0), point(10, 0), rocks)?.asteroidId).toBe('near');
    }
    for (const rocks of [
      [square('b'), square('a')],
      [square('a'), square('b')],
    ]) {
      expect(findNearestAsteroidImpact(point(-4, 0), point(10, 0), rocks)?.asteroidId).toBe('a');
    }
  });

  it('pinballs between distinct cluster faces without epsilon loops or extra distance', () => {
    const left = square('left', -4);
    const right = square('right', 4);
    const options = { maxDistance: 30, maxBounces: 3 };
    const path = previewAsteroidReflections(point(0, 0), point(4, 0), [left, right], options);
    expect(path).toEqual(
      previewAsteroidReflections(point(0, 0), point(4, 0), [right, left], options)
    );
    expect(path.impacts.map((impact) => impact.asteroidId)).toEqual([
      'right',
      'left',
      'right',
      'left',
    ]);
    expect(path.impacts.map((impact) => impact.distance)).toEqual([
      expect.closeTo(3, 9),
      expect.closeTo(6, 9),
      expect.closeTo(6, 9),
      expect.closeTo(6, 9),
    ]);
    expect(path.traveledDistance).toBeCloseTo(21, 9);
    expect(path.termination).toBe('bounce-limit');
  });

  it('ends at the distance budget mid-leg and at an ordinary absorbing rock', () => {
    const rocks = [square('left', -4), square('right', 4)];
    const path = previewAsteroidReflections(point(0, 0), point(1, 0), rocks, {
      maxDistance: 5,
      maxBounces: 4,
    });
    expect(path.termination).toBe('distance');
    expect(path.impacts).toHaveLength(1);
    expect(path.segments[1]?.end.x).toBeCloseTo(1, 9);
    const blocked = previewAsteroidReflections(point(0, 0), point(1, 0), rocks, {
      maxDistance: 100,
      maxBounces: 4,
      canReflect: (asteroid) => asteroid.id !== 'left',
    });
    expect(blocked.termination).toBe('blocked');
    expect(blocked.traveledDistance).toBeCloseTo(9, 9);
    expect(blocked.impacts.map((impact) => impact.asteroidId)).toEqual(['right', 'left']);
  });

  it('handles repeated vertices without NaN normals and reports stationary previews', () => {
    const repeatedCenter = { ...square(), vertices: 6, offsets: [1, 0, 0, 1, 1, 1] };
    const hit = findNearestAsteroidImpact(point(-4, -0.2), point(4, -0.2), [repeatedCenter]);
    expect(hit).not.toBeNull();
    expect(Math.hypot(hit?.normal.x ?? NaN, hit?.normal.y ?? NaN)).toBeCloseTo(1, 10);
    const path = previewAsteroidReflections(point(0, 0), point(0, 0), [], {
      maxDistance: 10,
      maxBounces: 2,
    });
    expect(path.termination).toBe('stationary');
    expect(path.segments).toEqual([]);
    expect(path.traveledDistance).toBe(0);
  });

  it('fails loudly on malformed or excessive contours instead of skipping a nearer rock', () => {
    const malformed = [
      { ...square(), position: point(NaN, 0) },
      { ...square(), size: Infinity },
      { ...square(), rotation: NaN },
      { ...square(), vertices: 2 },
      { ...square(), vertices: REFLECTION_LIMITS.vertices + 1 },
      { ...square(), vertices: 3.5 },
      { ...square(), offsets: [1, NaN, 1, 1] },
      { ...square(), offsets: [1, -1, 1, 1] },
      { ...square(), offsets: [0, 0, 0, 0] },
    ];
    for (const rock of malformed) {
      expect(() => findNearestAsteroidImpact(point(-4, 0), point(4, 0), [rock])).toThrow(
        RangeError
      );
    }
    expect(() =>
      findNearestAsteroidImpact(point(-4, 0), point(4, 0), [square(), square()])
    ).toThrow(RangeError);
    expect(() => reflectVector(point(1, 0), point(0, 0))).toThrow(RangeError);
    expect(() => reflectVector(point(Infinity, 0), point(1, 0))).toThrow(RangeError);
  });

  it('caps total work and path length rather than truncating the input obstacle list', () => {
    for (const options of [
      { maxDistance: Infinity, maxBounces: 1 },
      { maxDistance: -1, maxBounces: 1 },
      { maxDistance: REFLECTION_LIMITS.distance + 1, maxBounces: 1 },
      { maxDistance: 10, maxBounces: REFLECTION_LIMITS.bounces + 1 },
      { maxDistance: 10, maxBounces: 1.5 },
    ]) {
      expect(() => previewAsteroidReflections(point(0, 0), point(1, 0), [], options)).toThrow(
        RangeError
      );
    }
    const tooMany = Array.from({ length: REFLECTION_LIMITS.asteroids + 1 }, (_, i) =>
      square(`rock-${i}`)
    );
    expect(() =>
      previewAsteroidReflections(point(0, 0), point(1, 0), tooMany, {
        maxDistance: 10,
        maxBounces: 1,
      })
    ).toThrow(RangeError);
    const stop = previewAsteroidReflections(point(-4, 0), point(1, 0), [square()], {
      maxDistance: 10,
      maxBounces: 0,
    });
    expect(stop.termination).toBe('bounce-limit');
    expect(stop.impacts).toHaveLength(1);
    expect(stop.finalDirection).toEqual(point(1, 0));
  });
});
