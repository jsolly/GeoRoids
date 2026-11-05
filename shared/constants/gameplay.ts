import { WORLD } from '../world';

/**
 * Gameplay rules shared by the browser client and the authoritative server.
 * Presentation-only tuning (VISUAL, TOUCH, PALETTE, AUDIO, LOGGING) stays in src/constants.
 */

// ============================================================================
// GAME CONFIGURATION
// ============================================================================
export const GAME = {
  // Bank starting balance and simulation timing
  STARTING_SCORE: 0,

  // Physics
  FPS: 60,
  /** Spatial pace multiplier; simulation cadence and cooldowns stay fixed. */
  MOTION_SCALE: 0.5625, // 0.75 × 0.75 — extra 25% slowdown on the existing pace
  /** Extra multiplier applied only to player cruise, not world projectiles. */
  PLAYER_SPEED_SCALE: 1.25,
  FRICTION: 0.6,
} as const;

// ============================================================================
// SHIP CONFIGURATION
// ============================================================================
const EXPLODE_DURATION_FRAMES = 18;

export const SHIP = {
  // Shared Scout and Hauler movement, independent of saved mass and cargo.
  TURN_SPEED: 540,
  THRUST: 5 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE,
  MAX_VELOCITY: 2 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE,
  SIZE: 30, // Scout / classic hull height in pixels. Hauler uses kit size.

  // Combat
  MAX_LASERS: 5, // maximum lasers a ship can have at once

  // Health
  MAX_HEALTH: 100,
  HEALTH_REGEN_FRACTION_PER_SECOND: 0.02, // fraction of current max health
  HEALTH_REGEN_DELAY: 5, // seconds

  // Timing (in frames at 60 FPS)
  EXPLODE_DURATION_FRAMES: EXPLODE_DURATION_FRAMES, // 0.3 seconds of flash/explode
  INVINCIBILITY_DURATION_FRAMES: 180, // 3 seconds of blink after respawn
  INVINCIBILITY_BLINK_DURATION_FRAMES: 6, // 0.1 seconds
  // Parallel with explode so wall/roid death is flash → respawn+invuln, not a 3s corpse freeze.
  RESPAWN_DELAY_FRAMES: EXPLODE_DURATION_FRAMES,
  IMPACT_FLASH_FRAMES: 10, // hairline ring on a lethal wall/roid hit
} as const;

// ============================================================================
// DAMAGE CONFIGURATION
// ============================================================================
export const DAMAGE = {
  // Instant damage (applied immediately)
  LASER_HIT: 25, // Damage dealt by a single laser hit
  ASTEROID_COLLISION: 25, // One server-authoritative asteroid impact
} as const;

// ============================================================================
// LASER CONFIGURATION
// ============================================================================
export const LASER = {
  SPEED: 300 * GAME.MOTION_SCALE, // pixels per second
  /** World units a shot travels before it expires; the server enforces the same reach. */
  MAX_TRAVEL_DISTANCE: 800,
  EXPLODE_DURATION: 0.1, // seconds
  PREDICTION_TIMEOUT_MS: 2000, // Bound unacknowledged local shots during connection loss
  /** Projectile thickness for hits. Ship hull radii stay independent. */
  HIT_RADIUS: 4,
} as const;

// ============================================================================
// ASTEROID (ROID) CONFIGURATION
// ============================================================================
export const ROID = {
  // Movement and size
  /** Server asteroid velocity uses pixels per 60 Hz tick, unlike SPEED. */
  SERVER_VELOCITY_MAX: 4 * GAME.MOTION_SCALE,
  // Generated deposits: most drift slowly, small rocks drift and spin faster,
  // and a few streak across a field near the server speed limit.
  DRIFT_SPEED_MIN: 0.2 * GAME.MOTION_SCALE,
  DRIFT_SPEED_MAX: 2.4 * GAME.MOTION_SCALE,
  FAST_DRIFT_CHANCE: 0.07,
  /** Above the fastest ordinary drift, so streakers read as their own class. */
  FAST_DRIFT_SPEED_MIN: 3.2 * GAME.MOTION_SCALE,
  /** Radians per server frame; heavy-tailed so most rocks turn slowly. */
  SPIN_MIN: 0.0008,
  SPIN_MAX: 0.024,
  /** Ordinary deposits stay below the colossal class. */
  DEPOSIT_SIZE_MIN: 12,
  DEPOSIT_SIZE_MAX: 84,
  /** Above 1 favors small rocks; large ones stay common enough to fill a field. */
  DEPOSIT_SIZE_SKEW: 1.7,
  /** Drift and spin multipliers from the largest to the smallest deposit. */
  LARGE_ROCK_PACE: 0.6,
  SMALL_ROCK_PACE: 1.3,
  LARGE_ROCK_SPIN: 0.5,
  SMALL_ROCK_SPIN: 1.5,
  /** Relative outline jitter per material; crystal keeps its faceted symmetry. */
  OUTLINE_JITTER: { crystal: 0.08, ice: 0.14, metal: 0.06, rubble: 0.2 },
  /** Up to this many vertices beyond the material's base outline. */
  EXTRA_VERTICES: { crystal: 0, ice: 2, metal: 2, rubble: 3 },
  DEPOSIT_JAGGEDNESS: { rubble: 0.6, solid: 0.2 },
  /** Laser hits that break a metal deposit; other materials break in one. */
  METAL_HITS: 3,
  DEPOSIT_JAGGEDNESS_SPREAD: 0.15,
  SIZE: 50, // starting size in pixels

  // Scoring
  LARGE_MIN_SIZE: 40,
  POINTS_COLOSSAL: 200,
  POINTS_LARGE: 20,
  POINTS_MEDIUM: 50,
  POINTS_SMALL: 100,

  // Rare crew-scale rocks: too heavy for one tow or one coupling, and they
  // take many laser hits to mine.
  COLOSSAL_MIN_SIZE: 90,
  COLOSSAL_SIZE: 120,
  COLOSSAL_LASER_HITS: 16,
  COLOSSAL_CREW: 2,
  COLOSSAL_SECTOR_PERIOD: 5,
  COLOSSAL_CORE_EXCLUSION: 2,

  // Initial production field density.
  INITIAL_ROID_COUNT: 20,

  // Procedural deposits fill nearby sectors throughout the playable world.
  /** Splits stop adding fragments when this many rocks crowd one sector-wide circle. */
  SPLIT_NEARBY_LIMIT: 1_600,
} as const;

// ============================================================================
// DEPOSIT FIELDS
// ============================================================================
// A deterministic density field decides how many real deposits each sector
// owns and where they sit: sweeping rich fields and quiet voids instead of an
// even sprinkle. A harvested deposit slot regrows out of sight.
export const DEPOSIT_FIELD = {
  /** Deposits per 2,000-unit sector in the quietest void and the richest field core. */
  VOID_DEPOSITS: 26,
  PEAK_DEPOSITS: 360,
  /** Noise wavelengths for sweeping fields and the clumps inside them. */
  FIELD_SCALE: 9_000,
  CLUMP_SCALE: 1_400,
  /** Field noise below the low edge is void; above the high edge is a full core. */
  FIELD_EDGE_LOW: 0.3,
  FIELD_EDGE_HIGH: 0.85,
  /** Share of a field's richness that survives between clumps. */
  CLUMP_FLOOR: 0.3,
  /** Rich cores hold more stationary reef rocks. */
  STATIONARY_FRACTION_VOID: 0.2,
  STATIONARY_FRACTION_PEAK: 0.55,
  /**
   * Each interval restores this share of a sector's missing deposits, at least
   * one: a stripped field refills with a half-life of a few minutes.
   */
  REGROWTH_INTERVAL_MS: 12_000,
  REGROWTH_FRACTION: 0.05,
  /** Generated deposits keep this far inside the world rim. */
  RIM_MARGIN: 100,
  /** Generated deposits keep this far from the launch point. */
  LAUNCH_CLEARANCE: 240,
  /**
   * Richness is capped near launch and blends to full strength between these
   * radii; fast drifters stay out of the launch neighborhood.
   */
  LAUNCH_RICHNESS: 0.2,
  LAUNCH_CALM_INNER: 1_500,
  LAUNCH_CALM_OUTER: 4_000,
  /**
   * Half-width of the square around each pilot and probe where nothing
   * regrows: everything a pilot is ever sent, including a scanning pilot's
   * zoomed-out view.
   */
  REGROWTH_HIDDEN_DISTANCE: WORLD.interestRadius,
} as const;

// Collectible Earth-observation hardware.
export const SATELLITE_PICKUP = {
  SIZE: 24,
  ORBIT_RADIUS: 48,
  ORBIT_SPEED: 0.08 * GAME.MOTION_SCALE,
  SCORE_BONUS: 50,
  HEALTH: 50,
  AUTO_COLLECT_RANGE: 140,
  LIFETIME_FRAMES: 120 * GAME.FPS,
  SCAN_RANGE: 600,
  RESPAWN_FRAMES: 180,
  ORBIT_GAP: 8,
  MAX_COUNT: 6,
  SPAWN_RING_MIN: 380,
  SPAWN_RING_MAX: 480,
} as const;

// ============================================================================
// SNAPSHOT COLORS
// ============================================================================
/** Colors the server stamps on snapshot rows; clients draw the same inks. */
export const WIRE_PALETTE = {
  REMOTE: '#7DD3FC',
  /** Collectible EO hardware. */
  SATELLITE: '#C4B5FD',
} as const;
