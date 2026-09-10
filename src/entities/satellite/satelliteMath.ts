import type { Position, Velocity } from '../../../shared-types';
import { GAME, LASER } from '../../constants';

interface AimTarget {
  id: string;
  position: Position;
  health: number;
  exploding: boolean;
}

/** Compact figure-8 patrol offset around an orbit center. */
export function figure8Offset(phase: number, radiusX: number, radiusY: number): Position {
  return {
    x: radiusX * Math.cos(phase),
    y: (radiusY * Math.sin(2 * phase)) / 2,
  };
}

/** Ship-convention heading: forward is (cos a, -sin a). */
export function aimAngleToward(from: Position, to: Position): number {
  return Math.atan2(-(to.y - from.y), to.x - from.x);
}

export function applyAimJitter(angle: number, jitter: number, random: () => number): number {
  return angle + (random() - 0.5) * 2 * jitter;
}

export function findNearestLivingTarget<T extends AimTarget>(
  from: Position,
  targets: T[]
): T | null {
  let nearest: T | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    if (target.exploding || target.health <= 0) {
      continue;
    }
    const dist = Math.hypot(target.position.x - from.x, target.position.y - from.y);
    if (dist < best) {
      best = dist;
      nearest = target;
    }
  }
  return nearest;
}

export function distanceTo(from: Position, to: Position): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function laserStartFromAngle(position: Position, angle: number, radius: number): Position {
  return {
    x: position.x + Math.cos(angle) * radius * 1.2,
    y: position.y - Math.sin(angle) * radius * 1.2,
  };
}

export function laserVelocityFromAngle(
  angle: number,
  carry: Velocity,
  speedMultiplier = 1
): Velocity {
  return {
    x: (Math.cos(angle) * LASER.SPEED * speedMultiplier) / GAME.FPS + carry.x,
    y: (-Math.sin(angle) * LASER.SPEED * speedMultiplier) / GAME.FPS + carry.y,
  };
}

export function clampToRadius(position: Position, maxRadius: number): Position {
  const dist = Math.hypot(position.x, position.y);
  if (dist <= maxRadius || dist === 0) {
    return { x: position.x, y: position.y };
  }
  const scale = maxRadius / dist;
  return { x: position.x * scale, y: position.y * scale };
}
