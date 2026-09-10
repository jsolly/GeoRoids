import { assert, describe, expect, test } from 'vitest';
import { SHOCKWAVE } from '../../../src/constants';
import {
  applyShockwaveToBody,
  computeRadialImpulse,
  distanceFalloff,
  sizeImpulseScale,
} from '../../../src/physics/shockwave';

describe('collab-split shockwave impulse', () => {
  test('smaller objects receive a stronger kick than bigger ones', () => {
    expect(sizeImpulseScale(12)).toBeGreaterThan(sizeImpulseScale(25));
    expect(sizeImpulseScale(25)).toBeGreaterThan(sizeImpulseScale(50));
  });

  test('size scale stays inside the configured clamp', () => {
    expect(sizeImpulseScale(1)).toBe(SHOCKWAVE.MAX_SIZE_SCALE);
    expect(sizeImpulseScale(400)).toBe(SHOCKWAVE.MIN_SIZE_SCALE);
  });

  test('falloff is full at the origin and zero outside the wave', () => {
    expect(distanceFalloff(0, 150)).toBe(1);
    expect(distanceFalloff(75, 150)).toBeCloseTo(0.5);
    expect(distanceFalloff(151, 150)).toBe(0);
  });

  test('radial impulse pushes away from the origin', () => {
    const impulse = computeRadialImpulse({ x: 0, y: 0 }, { x: 40, y: 0 }, 12, {
      radius: 150,
      impulse: 4,
    });
    assert.exists(impulse);
    expect(impulse.x).toBeGreaterThan(0);
    expect(impulse.y).toBeCloseTo(0);
  });

  test('bodies outside the wave are left alone', () => {
    const next = applyShockwaveToBody(
      { position: { x: 500, y: 0 }, velocity: { x: 1, y: 0 }, size: 12 },
      { x: 0, y: 0 },
      { radius: 150, impulse: 8 }
    );
    expect(next).toBeNull();
  });

  test('a crumb near the origin outruns a giant at the same range', () => {
    const origin = { x: 0, y: 0 };
    const wave = { radius: SHOCKWAVE.HEAVY.radius, impulse: SHOCKWAVE.HEAVY.impulse };
    const crumb = applyShockwaveToBody(
      { position: { x: 30, y: 0 }, velocity: { x: 0, y: 0 }, size: 12 },
      origin,
      wave
    );
    const giant = applyShockwaveToBody(
      { position: { x: 30, y: 0 }, velocity: { x: 0, y: 0 }, size: 50 },
      origin,
      wave
    );
    assert.exists(crumb);
    assert.exists(giant);
    expect(Math.abs(crumb.x)).toBeGreaterThan(Math.abs(giant.x));
  });

  test('the heavy wave hits harder than the fast wave at the same range', () => {
    const body = { position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 }, size: 12 };
    const fast = applyShockwaveToBody(body, { x: 0, y: 0 }, SHOCKWAVE.FAST);
    const heavy = applyShockwaveToBody(body, { x: 0, y: 0 }, SHOCKWAVE.HEAVY);
    assert.exists(fast);
    assert.exists(heavy);
    expect(Math.abs(heavy.x)).toBeGreaterThan(Math.abs(fast.x));
  });
});
