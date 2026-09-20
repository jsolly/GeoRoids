import { WORLD } from '../../shared/world';
/**
 * Unified Constants - Consolidated from all constant files
 * Organized by domain for better maintainability
 */

import { getStoredItem } from '../utils/safeStorage';

// ============================================================================
// GAME CONFIGURATION
// ============================================================================
export const GAME = {
  // Lives and scoring
  START_LIVES: 3,
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
// SPAWN CONFIGURATION
// ============================================================================
export const SPAWN = {
  // Radius (px) around a living ally or open-sector center for new pilots.
  NEAR_CENTER_RADIUS: WORLD.spawnClusterRadius,
} as const;

// ============================================================================
// CANVAS CONFIGURATION
// ============================================================================
export const CANVAS = {
  INTERNAL_WIDTH: 800,
} as const;

// ============================================================================
// TOUCH CONTROLS
// ============================================================================
export const TOUCH = {
  // Canvas space reserved above the ability buttons so the radar stays readable.
  ACTION_RESERVE: 112,
  PHONE_MAX_WIDTH: 500,
  PHONE_LANDSCAPE_MAX_HEIGHT: 430,
  PHONE_LANDSCAPE_MAX_WIDTH: 1000,
  TABLET_MIN_SIDE: 820,
} as const;

export const STEERING = {
  DEAD_ZONE_PX: 24,
  ARROW_DISTANCE_PX: 64,
  ARROW_LENGTH_PX: 14,
  ARROW_HALF_WIDTH_PX: 9,
} as const;

// ============================================================================
// LOCKED PLAYFIELD PALETTE
// ============================================================================
export const PALETTE = {
  BG: '#000011',
  STARS: '#8BA3C7',
  LOCAL: '#5EEAD4',
  REMOTE: '#7DD3FC',
  ROID: '#94A3B8',
  /** Canonical terrain slate; subdued beneath ships, lasers, and pickups. */
  CONTOUR: '#5A6B7D',
  LASER_LOCAL: '#FDE68A',
  HUD: '#E2E8F0',
  HUD_MUTED: '#64748B',
  DANGER: '#F43F5E',
  HEALTH: '#4ADE80',
  /** Locked cream — wreckage/shard pickups + contour-laser blush. Same hex as Hauler tether. */
  LOOT: '#E8D5A3',
  /** Collectible EO hardware. */
  SATELLITE: '#C4B5FD',
} as const;

export const TITLE = {
  ACCENT: '#A78BFA',
} as const;

// Wave 2 feel: classic Asteroids silhouettes + Geometry Wars juice, still matt-blush.
// Ships stay hairline. Lasers / thrust / hits may bloom a little past stroke.
export const VISUAL = {
  SHIP_STROKE_WIDTH: 1.25,
  SHIP_GLOW: 1.25,
  // Thicker short cream dash plus a faint heading ghost — still a shot, never a beam.
  LASER_STROKE_WIDTH: 3.5,
  LASER_LENGTH: 24,
  LASER_TRAIL_LENGTH: 13,
  LASER_EXPLODE_RADIUS: 16,
  LASER_GLOW: 6,
  LASER_HIT_TICKS: 4,
  HEALTH_CAPSULE_HEIGHT: 1.5,
  BOUNDARY_STROKE_WIDTH: 1.25,
  BOUNDARY_GLOW: 1.25,
  ROID_STROKE_LARGE: 2,
  ROID_STROKE_MEDIUM: 1.5,
  ROID_STROKE_SMALL: 1.25,
  ROID_GLOW: 2.25,
  ROID_INNER_SCALE: 0.46,
  ROID_SHATTER_MS: 280,
  ROID_SHATTER_SPREAD: 1.8,
  // Open-V thruster with a shorter inner core; flickers between two lengths.
  THRUSTER_STROKE_WIDTH: 1.25,
  THRUSTER_GLOW: 2.25,
  THRUSTER_LENGTH_RATIO: 0.68,
  THRUSTER_FLICKER_RATIO: 0.4,
  THRUSTER_CORE_RATIO: 0.42,
  THRUSTER_FLICKER_MS: 50,
  // Hearth fire is the same open-V as ship thrust, scaled to the delivery zone.
  FURNACE_STROKE_WIDTH: 1.25,
  FURNACE_GLOW: 1.4,
  FURNACE_FLAME_STROKE_WIDTH: 2,
  FURNACE_FLAME_GLOW: 3.75,
  // Hull edges pop, then drift; ring + ticks, no filled fireball.
  EXPLOSION_STROKE_WIDTH: 1.25,
  EXPLOSION_SPREAD_RATIO: 2.05,
  EXPLOSION_SPARKS: 8,
  EXPLOSION_RING_RATIO: 2.35,
  EXPLOSION_HIT_TICKS: 4,
  // Sparse world-anchored star points seeded deterministically so they never twinkle or shift.
  STAR_SIZE: 1,
  STAR_SEED: 0x9e3779b9,
  STAR_ALPHA_MIN: 0.3,
  STAR_ALPHA_MAX: 0.8,
  LOOT_STROKE_WIDTH: 2,
  LOOT_GLOW: 2,
  /** Tap canister aura is slightly larger than stroke, still hairline-adjacent. */
  TAP_LOOT_GLOW: 2.5,
  TAP_LOOT_PULSE_MS: 1200,
  LOOT_UNDERSTROKE: 3.5,
  LOOT_SHARD_INNER: 0.42,
  LOOT_SHARD_DENSE_INNER: 0.68,
  /** Positive screen-space radius keeps tiny world drops visible at deep zoom. */
  LOOT_MIN_SCREEN_PX: 5,
  MINIMAP_SIZE: 96,
  MINIMAP_DOT: 5,
  MINIMAP_LOCAL_SIZE: 6,
  MINIMAP_VOID_ALPHA: 0.5,
  MINIMAP_RING_ALPHA: 0.85,
  HUD_INSET: 16,
  HUD_LIFE_SIZE: 14,
  HUD_LIFE_HEADING: Math.PI / 2,
  HUD_LIFE_GAP: 6,
  HUD_SCORE_GAP: 10,
  SCORE_FONT: '14px Arial',
  NAME_LABEL_FONT: '11px Arial',
  NAME_LABEL_ALPHA: 0.4,
  // Iso-contours: hairline slate, no glow. Index lines are only slightly stronger.
  CONTOUR_STROKE_WIDTH: 1,
  CONTOUR_ALPHA: 0.16,
  CONTOUR_INDEX_ALPHA: 0.24,
  CONTOUR_INDEX_EVERY: 3,
  // Static title map: crop, line weights, and sparse elevation labels.
  TITLE_TERRAIN_GRID_SIZE: 320,
  TITLE_TERRAIN_VIEW_SPAN: 3000,
  TITLE_CONTOUR_ALPHA: 0.28,
  TITLE_CONTOUR_INDEX_ALPHA: 0.52,
  TITLE_CONTOUR_WIDTH: 0.65,
  TITLE_CONTOUR_INDEX_WIDTH: 1.1,
  TITLE_LABEL_ALPHA: 0.5,
  TITLE_LABEL_SPACING: 520,
  TITLE_TERRAIN_LEVELS: 28,
  CONTOUR_LABEL_FONT: '10px "Courier New", monospace',
  CONTOUR_LABEL_ALPHA: 0.4,
  CONTOUR_LABEL_SPACING: 170,
  CONTOUR_LABEL_PADDING: 4,
  CONTOUR_LABEL_HEIGHT: 12,
  CONTOUR_LABEL_MARGIN_X: 28,
  CONTOUR_LABEL_MARGIN_Y: 18,
  // Cream iso-tangent under each live shot. Terrain answers; shots stay amber on top.
  CONTOUR_LASER_LENGTH: 42,
  CONTOUR_LASER_STROKE_WIDTH: 2,
  CONTOUR_LASER_ALPHA: 0.5,
} as const;

// ============================================================================
// SHIP CONFIGURATION
// ============================================================================
const EXPLODE_DURATION_FRAMES = 18;

export const SHIP = {
  // Movement
  TURN_SPEED: 450, // degrees per second
  THRUST: 5 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE,
  MAX_VELOCITY: 2 * GAME.MOTION_SCALE * GAME.PLAYER_SPEED_SCALE,
  SIZE: 30, // Surveyor / classic hull height in pixels. Hauler uses kit size.

  // Combat
  MAX_LASERS: 5, // maximum lasers a ship can have at once

  // Health
  MAX_HEALTH: 100,
  HEALTH_REGEN_RATE: 1, // per second
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
  MAX_COUNT: 200, // limit of lasers that can exist
  TRAVEL_DISTANCE_RATIO: 0.6, // fraction of screen width
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
  SPEED: 50 * GAME.MOTION_SCALE, // starting speed in pixels per second
  /** Server asteroid velocity uses pixels per 60 Hz tick, unlike SPEED. */
  SERVER_VELOCITY_MAX: 4 * GAME.MOTION_SCALE,
  SIZE: 50, // starting size in pixels
  VERTICES: 10, // average number of vertices
  JAGGEDNESS: 0.5, // 0 = smooth, 1 = jagged

  // Scoring
  POINTS_LARGE: 20,
  POINTS_MEDIUM: 50,
  POINTS_SMALL: 100,

  // Collaborative split: only the biggest asteroids, and only when two
  // distinct ships land laser hits within this window.
  // The server owns the clock, shooter identity, and resolve/expire.
  COLLAB_SPLIT_WINDOW_MS: 1000,
  COLLAB_SPLIT_MIN_SIZE: 40,
  // Same-shooter reports inside this gap are one shot (multi-client echo).
  COLLAB_HIT_DEDUPE_MS: 100,

  // Spawning (can be overridden by DEBUG.ROIDS.INITIAL_COUNT when in debug mode)
  // Production density; DEBUG.ROIDS.INITIAL_COUNT may override this only
  // when debug mode is explicitly enabled.
  INITIAL_ROID_COUNT: 20,

  // Procedural deposits fill nearby sectors throughout the playable world.
  FIELD_RADIUS: WORLD.radius,
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
// COLLAB SPLIT SHOCKWAVE
// ============================================================================
// Double phosphor ring + radial impulse when a biggest asteroid splits.
// First wave is small/fast; second is large/impactful. Size scale is inverse
// so crumbs and ships get shoved harder than remaining big rocks.
export const SHOCKWAVE = {
  REFERENCE_SIZE: 25,
  MIN_SIZE: 8,
  MIN_SIZE_SCALE: 0.28,
  MAX_SIZE_SCALE: 2.6,
  SIZE_EXPONENT: 1.2,
  FAST: {
    delayFrames: 0,
    durationFrames: 8,
    radius: 150,
    impulse: 3.2 * GAME.MOTION_SCALE,
    strokeWidth: 1.25,
  },
  HEAVY: {
    delayFrames: 7,
    durationFrames: 36,
    radius: 400,
    impulse: 7.0 * GAME.MOTION_SCALE,
    strokeWidth: 2.25,
  },
} as const;

// ============================================================================

// ============================================================================
// AUDIO CONFIGURATION
// ============================================================================
export const AUDIO = {
  MIN_PLAYBACK_RATE: 0.9,
  MAX_PLAYBACK_RATE: 1.1,
  HARPOON_LAUNCH: ['/sounds/harpoon-launch.m4a', 4, 0.04],
  HARPOON_LATCH: ['/sounds/harpoon-latch.m4a', 4, 0.045],
  HARPOON_RELEASE: ['/sounds/harpoon-release.m4a', 3, 0.035],
  ORBITAL_FIRE: ['/sounds/orbital-fire.m4a', 6, 0.032],
  ORBITAL_PICKUP: ['/sounds/orbital-pickup.m4a', 4, 0.04],
  TAP_EJECT: ['/sounds/tap-eject.m4a', 4, 0.055],
  LOOT_PICKUP: ['/sounds/loot-pickup.m4a', 8, 0.065],
  CORE_PICKUP: ['/sounds/core-pickup.m4a', 4, 0.04],
  SURVEY_SCAN: ['/sounds/survey-scan.m4a', 3, 0.035],
  RESPAWN: ['/sounds/respawn.m4a', 3, 0.035],
  ASTEROID_EXPLODE: ['/sounds/asteroid-explode.m4a', 5, 0.045],
  SATELLITE_EXPLODE: ['/sounds/satellite-explode.m4a', 4, 0.045],
  LOOT_EXPLODE: ['/sounds/loot-explode.m4a', 4, 0.04],
  EXPLOSION_PATH: 'sounds/explode.m4a',
  LASER_PATH: 'sounds/laser.m4a',
  HIT_PATH: 'sounds/hit.m4a',
  EXPLOSION_MAX_STREAMS: 5,
  LASER_MAX_STREAMS: 5,
  HIT_MAX_STREAMS: 5,
  // Quiet effects keep repeated combat cues comfortable.
  EXPLOSION_VOLUME: 0.055,
  LASER_VOLUME: 0.04,
  HIT_VOLUME: 0.035,
  // Soft looping beds sit under cues; never drown crystalline SFX.
  MENU_BED_VOLUME: 0.014,
  IN_GAME_BED_VOLUME: 0.012,
  BED_CROSSFADE_MS: 1600,
  // Used when the canvas size is unknown (matches PlayerNetwork nearby radius).
  FALLBACK_MAX_DISTANCE: 1200,
  // Floor so an on-screen source at the viewport edge stays a soft blush, not silent.
  MIN_IN_VIEWPORT_VOLUME: 0.2,
} as const;

// ============================================================================
// DEBUG CONFIGURATION
// ============================================================================
export const DEBUG = {
  // Master switch for debug features. Off in the default play path so yellow
  // DEBUG MODE chrome does not paint in production builds.
  ENABLED: false,

  SATELLITE_PICKUP: {
    COUNT: 6,
  },

  // Roid settings (overrides ROID.INITIAL_ROID_COUNT when in debug mode)
  ROIDS: {
    INITIAL_COUNT: 20, // Overrides ROID.INITIAL_ROID_COUNT in debug mode
    MOVEMENT: false,
    PLACE_ON_LOCAL_PLAYER: false,
    ALL_LARGE: true, // Force all generated roids to be large size
  },

  // Player positioning settings (Affects local and remote players)
  PLACE_PLAYERS_NEAR_CENTER: false,
  PLACE_PLAYERS_NEAR_BOUNDARY: false,
} as const;

// ============================================================================
// USER PREFERENCES
// ============================================================================
const PREFERENCES = {
  LOCAL_STORAGE_KEYS: {
    SOUND_ON: 'soundOn',
  } as const,
} as const;

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================
export const LOGGING = {
  // Opt in to `debug` locally when chasing a bug. Production must stay
  // `info` or quieter — per-frame `logger.debug` at 60 FPS stalls the
  // main thread, misses heartbeats, and disconnects both tabs.
  GLOBAL_LOG_LEVEL: 'info' as 'error' | 'warn' | 'info' | 'debug',

  // Forward warnings/errors and selected STATE info events to the server.
  FORWARD_TO_SERVER: true,

  // Whether to write logs to browser console
  WRITE_TO_CONSOLE: true,
} as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
const isSoundEnabled = (): boolean =>
  getStoredItem(PREFERENCES.LOCAL_STORAGE_KEYS.SOUND_ON) === 'true';

// Initialize sound preference checkbox after DOM is ready
function initializeSoundPreference() {
  const soundCheckbox = document.querySelector('#soundPref') as HTMLInputElement;
  if (soundCheckbox) {
    soundCheckbox.checked = isSoundEnabled();
  }
}

// Run initialization when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    // DOM not yet ready, wait for DOMContentLoaded
    document.addEventListener('DOMContentLoaded', initializeSoundPreference);
  } else {
    // DOM already ready, initialize immediately
    initializeSoundPreference();
  }
}
