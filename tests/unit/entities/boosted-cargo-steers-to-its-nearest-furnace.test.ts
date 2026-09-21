import { expect, test } from 'vitest';
import { ASTEROID_BOOST, furnaceHeading, tickAsteroidBoost } from '../../../shared/asteroidBoost';
import { nearestFurnace } from '../../../shared/furnaces';
import type { AsteroidBoost, Position } from '../../../shared-types';

function cargo(position: Position, phase: AsteroidBoost['phase'] = 'burning') {
  return { position, velocity: { x: 0, y: 2.5 }, boost: { phase, ownerId: 'launcher', angle: 0 } };
}

test.each([
  { x: 150, y: 0 },
  { x: 600, y: 500 },
  { x: -700, y: -400 },
])(
  'powered cargo at $x, $y cancels sideways momentum and reaches its nearest intake',
  (position) => {
    const body = cargo({ ...position });
    const furnace = nearestFurnace(position);
    let distance = Infinity;
    for (let frame = 0; frame < 1600; frame++) {
      tickAsteroidBoost(body);
      body.position.x += body.velocity.x;
      body.position.y += body.velocity.y;
      expect(Math.hypot(body.velocity.x, body.velocity.y)).toBeLessThanOrEqual(
        ASTEROID_BOOST.maxSpeed + 1e-9
      );
      distance = Math.hypot(
        body.position.x - furnace.position.x,
        body.position.y - furnace.position.y
      );
      if (distance <= furnace.radius) {
        break;
      }
    }
    expect(distance).toBeLessThanOrEqual(furnace.radius);
    expect(body.boost.ownerId).toBe('launcher');
  }
);

test('an armed rock points at its nearest furnace without applying thrust', () => {
  const body = cargo({ x: 150, y: 0 }, 'armed');
  const velocity = { ...body.velocity };
  tickAsteroidBoost(body);
  expect(body.boost.angle).toBe(furnaceHeading(body.position));
  expect(body.velocity).toEqual(velocity);
  body.position = { x: -4100, y: 0 };
  tickAsteroidBoost(body);
  expect(body.boost.angle).toBe(furnaceHeading(body.position));
});

test('guidance reacquires the nearest furnace after displacement', () => {
  const body = cargo({ x: 150, y: 0 });
  tickAsteroidBoost(body);
  const first = body.boost.angle;
  body.position = { x: -4100, y: 0 };
  tickAsteroidBoost(body);
  expect(body.boost.angle).not.toBe(first);
  expect(body.boost.angle).toBe(furnaceHeading(body.position));
});
