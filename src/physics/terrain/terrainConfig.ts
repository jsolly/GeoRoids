import { GAME } from '../../constants';

/**
 * Shared iso-contour terrain tunables. Client render and server ship physics
 * both read these so every player in a room gets the same hills and the same slope.
 */
export const TERRAIN = {
  DEFAULT_SEED: 0x7ec01d,
  /** Height samples across the arena diameter for marching squares. */
  GRID_SIZE: 224,
  /** Original contour density; elevation intervals compress over the plains. */
  LEVELS: 18,
  /** World units per noise cell — varied hills within the close gameplay view. */
  FEATURE_SCALE: 650,
  OCTAVES: 4,
  LACUNARITY: 2,
  PERSISTENCE: 0.48,
  /** Compress low relief into broad, nearly level plains. */
  FLAT_HEIGHT_BAND: 0.2,
  /** Plains retain one percent of the underlying height variation. */
  PLAIN_RELIEF_SCALE: 0.01,
  /** Smoothly join relief to the plains without a slope discontinuity. */
  FLAT_TRANSITION: 0.04,
  RELIEF_GAIN: 2,
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
   * via `/ FPS` each tick). Stronger than climb drag so descents feel rewarding.
   */
  SLOPE_ACCEL: 3.2 * GAME.MOTION_SCALE,
  /** Extra deceleration when velocity points uphill. */
  UPHILL_DRAG: 1.15,
  /** Gradient magnitude that maps to full slope force. */
  REF_GRADIENT: 0.0035,
  GRADIENT_EPS: 6,
  /** Gentle terrain keeps ordinary handling; tight contours reach full route cost. */
  TRAVEL_FLAT_GRADIENT: 0.0002,
  TRAVEL_STEEP_GRADIENT: 0.0025,
  /** A steep climb is a light tax, not a slog — still slower than following contours. */
  CLIMB_SPEED_FRACTION: 0.7,
  DESCENT_SPEED_BONUS: 1.15,
  /** Light downhill tug so contour-following stays the happy path. */
  CROSS_SLOPE_DRIFT: 0.16,
  /** Below this, contour-laser ticks stay off (flat spawn saddle stays quiet). */
  CONTOUR_LASER_MIN_GRAD: 0.00045,
} as const;
