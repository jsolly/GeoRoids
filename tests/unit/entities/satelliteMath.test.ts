import { describe, expect, test } from 'vitest';
import { GAME, LASER } from '../../../src/constants';
import {
  aimAngleToward,
  applyAimJitter,
  clampToRadius,
  figure8Offset,
  findNearestLivingTarget,
  laserVelocityFromAngle,
} from '../../../src/entities/satellite/satelliteMath';

describe('satellite aiming and patrol math', () => {
  test('figure-8 offset traces a closed loop around the origin', () => {
    const start = figure8Offset(0, 100, 60);
    const quarter = figure8Offset(Math.PI / 2, 100, 60);
    const half = figure8Offset(Math.PI, 100, 60);

    expect(start.x).toBeCloseTo(100);
    expect(start.y).toBeCloseTo(0);
    expect(quarter.x).toBeCloseTo(0);
    expect(Math.abs(quarter.y)).toBeGreaterThan(0);
    expect(half.x).toBeCloseTo(-100);
  });

  test('aimAngleToward uses ship heading convention toward +x', () => {
    expect(aimAngleToward({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(0);
    expect(aimAngleToward({ x: 0, y: 0 }, { x: 0, y: -100 })).toBeCloseTo(Math.PI / 2);
  });

  test('findNearestLivingTarget ignores dead and exploding ships', () => {
    const nearest = findNearestLivingTarget({ x: 0, y: 0 }, [
      { id: 'dead', position: { x: 10, y: 0 }, health: 0, exploding: false },
      { id: 'boom', position: { x: 12, y: 0 }, health: 50, exploding: true },
      { id: 'far', position: { x: 400, y: 0 }, health: 100, exploding: false },
      { id: 'near', position: { x: 80, y: 0 }, health: 100, exploding: false },
    ]);

    expect(nearest?.id).toBe('near');
  });

  test('aim jitter stays within the configured cone', () => {
    const jittered = applyAimJitter(0, 0.2, () => 1);
    expect(jittered).toBeCloseTo(0.2);
  });

  test('laser velocity follows the aimed heading and carries parent motion', () => {
    const velocity = laserVelocityFromAngle(0, { x: 1, y: 2 });
    expect(velocity.x).toBeCloseTo(LASER.SPEED / GAME.FPS + 1);
    expect(velocity.y).toBeCloseTo(2);
  });

  test('clampToRadius keeps points inside the arena', () => {
    const clamped = clampToRadius({ x: 5000, y: 0 }, 2800);
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(2800);
  });
});
