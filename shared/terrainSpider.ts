import { DAMAGE, GAME } from '../src/constants';

/**
 * Shared spider tuning. Distances are world units and speeds are world units
 * per authoritative 60 Hz frame, matching server asteroid motion and the
 * client's GAME.MOTION_SCALE.
 */
export const SPIDER = {
  MAX_ACTIVE: 48,
  SILK_BURSTS: 4,
  SHUDDER_FRAMES: 30,
  MAX_ROAMERS: 1,
  RESCUE_ATTRACT_DISTANCE: 2_600,
  RESCUE_SPAWN_INTERVAL_FRAMES: 12 * GAME.FPS,
  MAX_RESCUE_ROAMERS: 4,
  NEST_SPACING: 5_000,
  NEST_WAKE_DISTANCE: 4_200,
  NEST_SPAWN_SAFE_RADIUS: 1_600,
  NEST_PATROL_RADIUS: 240,
  NEST_ACQUIRE_DISTANCE: 420,
  NEST_LEASH_DISTANCE: 850,
  NEST_CHASE_FRAMES: 8 * GAME.FPS,
  NEST_GUARDS: 10,
  INFLUENCE_RADIUS: 280,
  SCUTTLE_SPEED: 1.25 * GAME.MOTION_SCALE,
  HUNT_SPEED: 4 * GAME.MOTION_SCALE,
  TURN_RATE: 0.04,
  HUNT_ACQUIRE_DISTANCE: 900,
  HUNT_RELEASE_DISTANCE: 2_600,
  MAX_HEALTH: DAMAGE.LASER_HIT,
  BITE_DISTANCE: 44,
  HIT_RADIUS: 36,
  BITE_COOLDOWN_FRAMES: 60,
  SPAWN_INTERVAL_FRAMES: 3 * 60 * GAME.FPS,
  SPAWN_INTERVAL_MAX_FRAMES: 5 * 60 * GAME.FPS,
  SPAWN_RADIUS_MIN: 1_600,
  SPAWN_RADIUS_MAX: 2_200,
  FURNACE_SAFE_RADIUS: 360,
  STARTER_SAFE_RADIUS: 720,
  WORLD_INSET: 500,
  DESPAWN_DISTANCE: 5_600,
} as const;

/** Size classes: hit radius and drawing scale grow together. */
const SPIDER_SIZES = [0.72, 1, 1.38] as const;

/**
 * Stable per-spider hash (FNV-1a over the ID) so the server and every client
 * derive the same size and look without new wire fields.
 */
export function spiderHash(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/** Roughly 30% small, 45% medium, 25% large. */
export function spiderScale(id: string): (typeof SPIDER_SIZES)[number] {
  const roll = spiderHash(id) % 100;
  return SPIDER_SIZES[roll < 30 ? 0 : roll < 75 ? 1 : 2];
}

export function spiderHitRadius(id: string): number {
  return SPIDER.HIT_RADIUS * spiderScale(id);
}
