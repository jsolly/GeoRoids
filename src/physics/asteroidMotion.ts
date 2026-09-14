import { ROID } from '../constants';
import { getGameBoundary } from './boundary';

/** Asteroids inhabit the full world; the server activates nearby sectors. */
export function getAsteroidFieldRadius(): number {
  return Math.min(getGameBoundary().radius, ROID.FIELD_RADIUS);
}

/** Return a drifting asteroid inside the circular world at its outer edge. */
export function containAsteroidPositionInto(
  dest: { x: number; y: number },
  x: number,
  y: number
): { x: number; y: number } {
  const { cx, cy } = getGameBoundary();
  const radius = getAsteroidFieldRadius();
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist <= radius || dist === 0) {
    dest.x = x;
    dest.y = y;
    return dest;
  }
  const scale = (radius - 1e-5) / dist;
  dest.x = cx + dx * scale;
  dest.y = cy + dy * scale;
  return dest;
}

export function containAsteroidPosition(x: number, y: number): { x: number; y: number } {
  return containAsteroidPositionInto({ x: 0, y: 0 }, x, y);
}

export function stepAsteroidMotionInto(
  position: { x: number; y: number },
  velocity: { x: number; y: number },
  tickScale: number,
  outPosition: { x: number; y: number },
  outVelocity: { x: number; y: number }
): void {
  const { cx, cy } = getGameBoundary();
  const radius = getAsteroidFieldRadius();
  let x = position.x + velocity.x * tickScale;
  let y = position.y + velocity.y * tickScale;
  let vx = velocity.x;
  let vy = velocity.y;

  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > radius && dist > 0) {
    containAsteroidPositionInto(outPosition, x, y);
    x = outPosition.x;
    y = outPosition.y;
    const nx = dx / dist;
    const ny = dy / dist;
    const radial = vx * nx + vy * ny;
    if (radial > 0) {
      vx -= 2 * radial * nx;
      vy -= 2 * radial * ny;
    }
  }

  outPosition.x = x;
  outPosition.y = y;
  outVelocity.x = vx;
  outVelocity.y = vy;
}

export function stepAsteroidMotion(
  position: { x: number; y: number },
  velocity: { x: number; y: number },
  tickScale = 1
): { position: { x: number; y: number }; velocity: { x: number; y: number } } {
  const nextPosition = { x: 0, y: 0 };
  const nextVelocity = { x: 0, y: 0 };
  stepAsteroidMotionInto(position, velocity, tickScale, nextPosition, nextVelocity);
  return { position: nextPosition, velocity: nextVelocity };
}

/**
 * Test whether a world point falls inside the ship-centered 1:1 viewport.
 * Draw culling also needs the object's radius and stroke margin.
 */
export function isOnPlayfieldCanvas(
  world: { x: number; y: number },
  ship: { x: number; y: number },
  canvas: { width: number; height: number } = { width: 1920, height: 1080 }
): boolean {
  const screenX = canvas.width / 2 - ship.x + world.x;
  const screenY = canvas.height / 2 - ship.y + world.y;
  return screenX >= 0 && screenX <= canvas.width && screenY >= 0 && screenY <= canvas.height;
}

export function isPoseInAsteroidField(x: number, y: number, slop = 1): boolean {
  const { cx, cy } = getGameBoundary();
  return Math.hypot(x - cx, y - cy) <= getAsteroidFieldRadius() + slop;
}
