import type { Position, Velocity } from '../shared-types';

/** Limits for the server-owned session and pose handoff protocol. */
export const PLAYER_MOTION = {
  maxSessions: 128,
  reconnectGraceMs: 2000,
  handoffTimeoutMs: 2000,
  /** Lead credit covers 150ms transport jitter once, not once per packet. */
  poseLeadFrames: 9,
  poseTolerance: 2,
} as const;

export function finiteMotionVector(vector: Position): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Math.abs(vector.x) <= 10_000_000 &&
    Math.abs(vector.y) <= 10_000_000
  );
}

export function capMotionVelocity(velocity: Velocity, maximum: number): Velocity {
  if (!finiteMotionVector(velocity) || !Number.isFinite(maximum) || maximum < 0) {
    throw new RangeError('Motion velocity and cap must be finite');
  }
  const magnitude = Math.hypot(velocity.x, velocity.y);
  const scale = magnitude > maximum && magnitude > 0 ? maximum / magnitude : 1;
  return { x: velocity.x * scale, y: velocity.y * scale };
}
