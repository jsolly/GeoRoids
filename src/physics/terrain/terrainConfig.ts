/** Shared mountain shape and ship slope physics for the client and server. */
export const TERRAIN = {
  /** Retained in room snapshots for compatibility. The mountain is seed-independent. */
  DEFAULT_SEED: 0x7ec01d,
  GRID_SIZE: 112,
  /** Equally spaced heights form concentric rings around the summit. */
  LEVELS: 24,
  /** Relative elevation; no real-world unit is assigned. */
  PEAK_HEIGHT: 1,
  /** Downhill acceleration in velocity units per second, below even heavy-ship thrust. */
  SLOPE_ACCEL: 1.6,
  /** Climbing loses radial speed but sustained thrust can still reach the summit. */
  UPHILL_DRAG: 0.8,
  /** Maximum slope for a radius-3100 mountain. */
  REF_GRADIENT: Math.PI / 6200,
  /** Existing laser terrain highlights remain visual-only. */
  CONTOUR_LASER_MIN_GRAD: 0.00045,
} as const;
