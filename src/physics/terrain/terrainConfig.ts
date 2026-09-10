/**
 * Shared iso-contour terrain tunables. Client render and server ship physics
 * both read these so every player in a room gets the same hills and the same slope.
 */
export const TERRAIN = {
  DEFAULT_SEED: 0x7ec01d,
  /** Height samples across the arena diameter for marching squares. */
  GRID_SIZE: 224,
  /** Evenly spaced iso levels (tight lines = steep). */
  LEVELS: 18,
  /** World units per noise cell — varied hills within the close gameplay view. */
  FEATURE_SCALE: 650,
  OCTAVES: 4,
  LACUNARITY: 2,
  PERSISTENCE: 0.48,
  /** Seeded gaussian hills/valleys in the mid-ring so the map has readable landmarks. */
  LANDMARK_COUNT: 6,
  LANDMARK_MIN_RADIUS: 0.32,
  LANDMARK_MAX_RADIUS: 0.74,
  LANDMARK_AMP: 0.72,
  LANDMARK_SIGMA_MIN: 220,
  LANDMARK_SIGMA_MAX: 500,
  /** Fade height to a flat saddle at the origin so spawn stays stable. */
  FLATTEN_SIGMA: 140,
  /** Smoothly meet the flat exterior instead of introducing a rim cliff. */
  RIM_FADE_WIDTH: 260,
  /**
   * Downslope acceleration in the same units as SHIP.THRUST (px/s² as applied
   * via `/ FPS` each tick). About half of thrust so ships can still climb.
   */
  SLOPE_ACCEL: 2.4,
  /** Extra deceleration when velocity points uphill. */
  UPHILL_DRAG: 1.8,
  /** Gradient magnitude that maps to full slope force. */
  REF_GRADIENT: 0.0035,
  GRADIENT_EPS: 6,
  /** Below this, contour-laser ticks stay off (flat spawn saddle stays quiet). */
  CONTOUR_LASER_MIN_GRAD: 0.00045,
} as const;
