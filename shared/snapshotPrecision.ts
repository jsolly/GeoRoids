import type { Position, ServerGameSnapshot } from '../shared-types';

/** Round only the encoder's detached, validated world. Never pass live engine state. */
export function quantizeSnapshotKinematics(state: ServerGameSnapshot): void {
  const factor = 10_000;
  const maximum = Number.MAX_SAFE_INTEGER / factor;
  const rounded = (value: number): number => {
    const result =
      Number.isInteger(value) || Math.abs(value) > maximum
        ? value
        : Math.round(value * factor) / factor;
    // JSON encodes negative zero as zero; retain the same canonical value in baselines.
    return result === 0 ? 0 : result;
  };
  const vector = (value: Position): void => {
    value.x = rounded(value.x);
    value.y = rounded(value.y);
  };
  // Keep ship poses and handoff anchors exact: they feed strict motion validation.
  // Resources, counters, shape geometry, and unknown fields also stay untouched.
  for (const row of state.asteroids) {
    vector(row.position);
    vector(row.velocity);
    row.rotation = rounded(row.rotation);
  }
  for (const row of state.loot) {
    vector(row.position);
  }
  for (const row of state.satellitePickups) {
    vector(row.position);
    vector(row.velocity);
    row.angle = rounded(row.angle);
  }
  for (const row of state.playerProjectiles) {
    vector(row.position);
    vector(row.prevPosition);
    vector(row.velocity);
  }
}
