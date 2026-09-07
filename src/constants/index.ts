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

  // Network (can be overridden by DEBUG.BOT_PLAYER.COUNT when in debug mode)
  BOT_COUNT: 9,

  // Physics
  FPS: 60,
  FRICTION: 0.6,
} as const;

// ============================================================================
// SPAWN CONFIGURATION
// ============================================================================
export const SPAWN = {
  // Radius (px) around the arena center within which human players spawn.
  // The arena boundary radius is ~3100px, so spawning anywhere inside it puts
  // players thousands of px apart — far outside each other's viewport, so two
  // people joining the same server never see one another. Clustering spawns
  // near the center keeps freshly-joined players within view of each other
  // (max separation ~2x this radius) and near where bots/asteroids converge.
  NEAR_CENTER_RADIUS: 150,
} as const;

// ============================================================================
// CANVAS CONFIGURATION
// ============================================================================
export const CANVAS = {
  INTERNAL_WIDTH: 800,
  INTERNAL_HEIGHT: 600,
  DEFAULT_CENTER_X: 400,
  DEFAULT_CENTER_Y: 300,

  // Text rendering
  TEXT_SIZE: 40,
  TEXT_FADE_TIME: 2.5,
} as const;

// ============================================================================
// TOUCH CONTROLS
// ============================================================================
export const TOUCH = {
  STICK_RADIUS: 56,
  STICK_DEADZONE: 0.18,
  STICK_THRUST: 0.38,
  FIRE_SIZE: 72,
  // Canvas space reserved above the fire button so the radar stays readable.
  FIRE_RESERVE: 112,
  PHONE_MAX_WIDTH: 500,
  PHONE_LANDSCAPE_MAX_HEIGHT: 430,
  PHONE_LANDSCAPE_MAX_WIDTH: 1000,
  TABLET_MIN_SIDE: 820,
} as const;

// ============================================================================
// LOCKED PLAYFIELD PALETTE
// ============================================================================
export const PALETTE = {
  BG: '#000011',
  STARS: '#8BA3C7',
  LOCAL: '#5EEAD4',
  REMOTE: '#7DD3FC',
  BOT: '#FB923C',
  ROID: '#94A3B8',
  /** Darker than HUD_MUTED so topo lines stay behind ships/lasers/roids. */
  CONTOUR: '#334155',
  LASER_LOCAL: '#FDE68A',
  LASER_ENEMY: '#FCA5A5',
  HUD: '#E2E8F0',
  HUD_MUTED: '#64748B',
  DANGER: '#F43F5E',
  HEALTH: '#4ADE80',
  LOOT: '#FBBF24',
  SHIELD: '#67E8F9',
} as const;

export const TITLE = {
  ACCENT: '#A78BFA',
} as const;

// Wave 2 feel: classic Asteroids silhouettes + Geometry Wars juice, still matt-blush.
// Ships stay hairline. Lasers / thrust / hits may bloom a little past stroke.
export const VISUAL = {
  SHIP_STROKE_WIDTH: 1.25,
  SHIP_GLOW: 1.25,
  // Short cream dash plus a faint heading ghost — still a shot, never a beam.
  LASER_STROKE_WIDTH: 2,
  LASER_LENGTH: 15,
  LASER_TRAIL_LENGTH: 8,
  LASER_EXPLODE_RADIUS: 10,
  LASER_GLOW: 3.5,
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
  // Hull edges pop, then drift; ring + ticks, no filled fireball.
  EXPLOSION_STROKE_WIDTH: 1.25,
  EXPLOSION_SPREAD_RATIO: 2.05,
  EXPLOSION_SPARKS: 8,
  EXPLOSION_RING_RATIO: 2.35,
  EXPLOSION_HIT_TICKS: 4,
  // Sparse world-anchored star points seeded deterministically so they never twinkle or shift.
  STAR_COUNT: 900,
  STAR_SIZE: 1,
  STAR_SEED: 0x9e3779b9,
  STAR_ALPHA_MIN: 0.3,
  STAR_ALPHA_MAX: 0.8,
  LOOT_STROKE_WIDTH: 1.25,
  LOOT_GLOW: 1.25,
  FUEL_BAR_WIDTH: 72,
  FUEL_BAR_HEIGHT: 2,
  // Title void uses the same 1px #8BA3C7 points; density matches play (~48 / 1080p).
  TITLE_STARS_PER_1080P: 48,
  MINIMAP_SIZE: 96,
  MINIMAP_DOT: 5,
  MINIMAP_LOCAL_SIZE: 6,
  MINIMAP_ROID: 1.5,
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
  // Hairline shield ring; glow capped to stroke so it stays a vector outline.
  SHIELD_STROKE_WIDTH: 1.25,
  SHIELD_GLOW: 1.25,
} as const;

// ============================================================================
// SHIP CONFIGURATION
// ============================================================================
const EXPLODE_DURATION_FRAMES = 18;

export const SHIP = {
  // Movement
  TURN_SPEED: 450, // degrees per second
  THRUST: 5, // pixels per second² (acceleration)
  MAX_VELOCITY: 8, // pixels per second
  BOT_FRICTION: 2.0, // higher = more friction for bots
  SIZE: 30, // height in pixels

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
  BOUNDARY_COLLISION: 100, // Instant kill when hitting game boundary
  ASTEROID_COLLISION: 100, // Instant kill — same flash/explode path as the wall

  // Damage over time (applied per second while colliding)
  PLAYER_COLLISION_PER_SECOND: 20, // Damage per second when colliding with another player

  // Damage intervals (calculated from DPS)
  PLAYER_COLLISION_INTERVAL_MS: 50, // 1000ms / 20 DPS = 50ms per damage tick
} as const;

// ============================================================================
// LASER CONFIGURATION
// ============================================================================
export const LASER = {
  SPEED: 300, // pixels per second
  MAX_COUNT: 200, // limit of lasers that can exist
  TRAVEL_DISTANCE_RATIO: 0.6, // fraction of screen width
  EXPLODE_DURATION: 0.1, // seconds
} as const;

// ============================================================================
// ASTEROID (ROID) CONFIGURATION
// ============================================================================
export const ROID = {
  // Movement and size
  SPEED: 50, // starting speed in pixels per second
  SIZE: 50, // starting size in pixels
  VERTICES: 10, // average number of vertices
  JAGGEDNESS: 0.5, // 0 = smooth, 1 = jagged

  // Scoring
  POINTS_LARGE: 20,
  POINTS_MEDIUM: 50,
  POINTS_SMALL: 100,

  // Collaborative split: only the biggest asteroids, and only when two
  // distinct ships (player or bot) land laser hits within this window.
  // The server owns the clock, shooter identity, and resolve/expire.
  COLLAB_SPLIT_WINDOW_MS: 1000,
  COLLAB_SPLIT_MIN_SIZE: 40,
  // Same-shooter reports inside this gap are one shot (multi-client echo).
  COLLAB_HIT_DEDUPE_MS: 100,

  // Spawning (can be overridden by DEBUG.ROIDS.INITIAL_COUNT when in debug mode)
  // Production density; DEBUG.ROIDS.INITIAL_COUNT may override this only
  // when debug mode is explicitly enabled.
  INITIAL_ROID_COUNT: 20,
  MIN_COUNT: 5,
  MAX_COUNT: 20,
  SPAWN_TIME_FRAMES: 180, // 3 seconds at 60 FPS

  // Shared moving belt. The ship-kill wall is ~3100px; a 1080p camera around a
  // center-spawned ship only sees ~960×540. Opposite-side wrap at the wall
  // parked every roid at ~3000px (minimap dots, empty canvas). Keep the belt
  // inside the same "nearby" radius the audio/network layer already uses.
  FIELD_RADIUS: 1200,
  FIELD_INNER_SCALE: 0.96,
} as const;

// ============================================================================
// EMP PULSE CONFIGURATION
// ============================================================================
export const EMP = {
  RADIUS: 250, // pixels
  DURATION: 0.5, // seconds
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
    impulse: 3.2,
    strokeWidth: 1.25,
  },
  HEAVY: {
    delayFrames: 7,
    durationFrames: 36,
    radius: 400,
    impulse: 7.0,
    strokeWidth: 2.25,
  },
} as const;

// ============================================================================
// FUEL CONFIGURATION
// ============================================================================
// Shared tank on every kit. Biggest rocks drop fuel; Quake shock / leftover
// EMP spends it. Reuses PALETTE.LOOT (matt amber) — do not add a sixth kit.
export const FUEL = {
  MAX: 100,
  START: 50,
  EMP_COST: 25,
  DROP_AMOUNT: 25,
  DROP_RADIUS: 8,
  MIN_ROID_SIZE_TO_DROP: ROID.COLLAB_SPLIT_MIN_SIZE,
} as const;

// ============================================================================
// SHIELD CONFIGURATION
// ============================================================================
// Timed bubble that blocks enemy lasers only. Duration is short and cooldown
// is longer so camping the shield is never free. Shared by players and bots.
export const SHIELD = {
  DURATION_SECONDS: 2,
  COOLDOWN_SECONDS: 6,
  RADIUS_RATIO: 1.55,
  FLASH_SECONDS: 0.12,
  BOT_HEALTH_THRESHOLD: 0.7,
  BOT_ACTIVATE_CHANCE: 0.02,
} as const;

// ============================================================================
// AUDIO CONFIGURATION
// ============================================================================
export const AUDIO = {
  EXPLOSION_PATH: 'sounds/explode.m4a',
  LASER_PATH: 'sounds/laser.m4a',
  HIT_PATH: 'sounds/hit.m4a',
  THRUST_PATH: 'sounds/thrust.m4a',
  EXPLOSION_MAX_STREAMS: 5,
  LASER_MAX_STREAMS: 5,
  HIT_MAX_STREAMS: 5,
  THRUST_MAX_STREAMS: 2,
  // Soft matt-blush levels — quieter than arcade default, loops stay under one-shots.
  EXPLOSION_VOLUME: 0.055,
  LASER_VOLUME: 0.04,
  HIT_VOLUME: 0.035,
  THRUST_VOLUME: 0.03,
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

  // Local player settings
  LOCAL_PLAYER: {
    INVINCIBLE: false,
    SPAWN_PROTECTION: true,
  },

  // Remote player settings
  REMOTE_PLAYER: {
    // Add remote player specific settings here as needed
  },

  // Bot player settings
  BOT_PLAYER: {
    COUNT: 2, // Reduced for better performance during development (overrides GAME.BOT_COUNT when in debug mode)
    MOVEMENT: true,
    LASERS: true,
    SPAWN_PROTECTION: false,
  },

  // Roid settings (overrides ROID.INITIAL_ROID_COUNT when in debug mode)
  ROIDS: {
    INITIAL_COUNT: 20, // Overrides ROID.INITIAL_ROID_COUNT in debug mode
    MOVEMENT: false,
    PLACE_ON_BOT: false,
    PLACE_ON_LOCAL_PLAYER: false,
    ALL_LARGE: true, // Force all generated roids to be large size
  },

  // Player positioning settings (Affects local, remote, and bot players)
  PLACE_PLAYERS_NEAR_CENTER: false,
  PLACE_PLAYERS_NEAR_BOUNDARY: false,
} as const;

// ============================================================================
// USER PREFERENCES
// ============================================================================
export const PREFERENCES = {
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

  // Whether to forward client logs to the server (warn+ only; see Logger)
  FORWARD_TO_SERVER: true,

  // Whether to write logs to browser console
  WRITE_TO_CONSOLE: true,
} as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
export const isSoundEnabled = (): boolean =>
  getStoredItem(PREFERENCES.LOCAL_STORAGE_KEYS.SOUND_ON) === 'true';

// Initialize sound preference checkbox after DOM is ready
function initializeSoundPreference() {
  const soundCheckbox = document.getElementById('soundPref') as HTMLInputElement;
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
