import { describe, expect, test } from 'vitest';
import {
  findNearestShieldImpact,
  reflectProjectileVelocity,
} from '../../../shared/shieldReflection';

const shield = (id: string, x: number, y: number, radius = 10) => ({
  id,
  position: { x, y },
  radius,
});

describe('swept shield reflection', () => {
  test('returns the radial contact normal and first impact distance', () => {
    const impact = findNearestShieldImpact({ x: -30, y: 0 }, { x: 30, y: 0 }, [shield('a', 0, 0)]);

    expect(impact).toEqual({
      shieldId: 'a',
      point: { x: -10, y: 0 },
      normal: { x: -1, y: 0 },
      distance: 20,
    });
  });

  test('preserves speed while reflecting across a diagonal radial normal', () => {
    const incoming = { x: 3, y: -4 };
    const reflected = reflectProjectileVelocity(incoming, { x: 0, y: -1 });

    expect(reflected).toEqual({ x: 3, y: 4 });
    expect(Math.hypot(reflected.x, reflected.y)).toBe(Math.hypot(incoming.x, incoming.y));
  });

  test('selects the nearest shield and skips only the just-hit surface at the origin', () => {
    const shields = [shield('near', 0, 0), shield('far', 40, 0)];
    const first = findNearestShieldImpact({ x: -30, y: 0 }, { x: 60, y: 0 }, shields);
    expect(first?.shieldId).toBe('near');

    const second = findNearestShieldImpact(
      first?.point ?? { x: -10, y: 0 },
      { x: 60, y: 0 },
      shields,
      'near'
    );
    expect(second?.shieldId).toBe('far');
  });

  test('uses the exit surface when a swept segment starts inside a shield', () => {
    const impact = findNearestShieldImpact({ x: 0, y: 0 }, { x: 30, y: 0 }, [shield('a', 0, 0)]);

    expect(impact?.point.x).toBe(10);
    expect(impact?.normal).toEqual({ x: 1, y: 0 });
    expect(impact?.distance).toBe(10);
  });

  test('reports an inward pointblank origin as an immediate radial contact', () => {
    const impact = findNearestShieldImpact({ x: 5, y: 0 }, { x: -30, y: 0 }, [shield('a', 0, 0)]);

    expect(impact).toEqual({
      shieldId: 'a',
      point: { x: 5, y: 0 },
      normal: { x: 1, y: 0 },
      distance: 0,
    });
  });

  test('rejects invalid or unbounded reflection input', () => {
    expect(() =>
      findNearestShieldImpact({ x: Number.NaN, y: 0 }, { x: 1, y: 0 }, [shield('a', 0, 0)])
    ).toThrow(RangeError);
    expect(() =>
      findNearestShieldImpact({ x: 0, y: 0 }, { x: 1, y: 0 }, [shield('a', 0, 0, 0)])
    ).toThrow(RangeError);
  });
});
