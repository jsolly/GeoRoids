import type { Position, Velocity } from '../shared-types';

/** Limits for the server-owned session and pose handoff protocol. */
export const PLAYER_MOTION = {
  maxSessions: 128,
  reconnectGraceMs: 2000,
  handoffTimeoutMs: 2000,
  /**
   * After the live socket is gone, restore the last ship only inside this
   * window. Longer gaps start a new flight with the monthly score.
   */
  returnToShipMs: 30_000,
  /** Lead credit covers 150ms transport jitter once, not once per packet. */
  poseLeadFrames: 9,
  poseTolerance: 2,
  /** External blast speed decays back to the normal flight cap each frame. */
  knockbackRetention: 0.96,
} as const;

/** True when `now` is still inside the brief-disconnect return window. */
export function flightReturnWindowOpen(lastSeenAt: number, now: number): boolean {
  return (
    Number.isFinite(lastSeenAt) &&
    Number.isFinite(now) &&
    now >= lastSeenAt &&
    now - lastSeenAt <= PLAYER_MOTION.returnToShipMs
  );
}

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
