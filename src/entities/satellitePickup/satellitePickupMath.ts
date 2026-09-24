import type { Position, Velocity } from '../../../shared-types';
import { SATELLITE_PICKUP } from '../../constants';

/** Circular offset around an owner. */
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

/** Keep an orbiting pickup outside the owner's kit hull. */
export function orbitRadiusForOwner(ownerRadius: number, pickupRadius: number): number {
  return Math.max(
    SATELLITE_PICKUP.ORBIT_RADIUS,
    ownerRadius + pickupRadius + SATELLITE_PICKUP.ORBIT_GAP
  );
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
  slack = 0
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
