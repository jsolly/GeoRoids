import type { Position, Velocity } from '../../../shared-types';
import { SATELLITE_PICKUP } from '../../constants';

/** Circular offset around an owner or loose-orbit center. */
export function orbitOffset(phase: number, radius: number): Position {
  return {
    x: Math.cos(phase) * radius,
    y: -Math.sin(phase) * radius,
  };
}

export function attachOrbitPosition(owner: Position, phase: number, radius: number): Position {
  const offset = orbitOffset(phase, radius);
  return {
    x: owner.x + offset.x,
    y: owner.y + offset.y,
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

export function advanceDriftCenter(
  center: Position,
  driftAngle: number,
  speed: number,
  maxRadius: number
): { center: Position; driftAngle: number } {
  const next = clampToRadius(
    {
      x: center.x + Math.cos(driftAngle) * speed,
      y: center.y + Math.sin(driftAngle) * speed,
    },
    maxRadius
  );
  const dist = Math.hypot(next.x, next.y);
  let nextAngle = driftAngle;
  if (dist > maxRadius - 40) {
    nextAngle = Math.atan2(-next.y, -next.x);
  }
  return { center: next, driftAngle: nextAngle };
}

export function velocityFromDelta(prev: Position, next: Position): Velocity {
  return {
    x: next.x - prev.x,
    y: next.y - prev.y,
  };
}

export function isWithinCollectRange(
  ship: Position,
  pickup: Position,
  shipRadius: number,
  pickupRadius: number,
  slack: number = SATELLITE_PICKUP.COLLECT_SLACK
): boolean {
  const limit = shipRadius + pickupRadius + slack;
  return Math.hypot(pickup.x - ship.x, pickup.y - ship.y) <= limit;
}

export function spawnRingPosition(
  index: number,
  count: number,
  random: () => number,
  ringMin = SATELLITE_PICKUP.SPAWN_RING_MIN,
  ringMax = SATELLITE_PICKUP.SPAWN_RING_MAX
): Position {
  const base = (index / Math.max(count, 1)) * Math.PI * 2;
  const jitter = (random() - 0.5) * 0.4;
  const angle = base + jitter;
  const radius = ringMin + random() * (ringMax - ringMin);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}
