import { DAMAGE, GAME } from '../src/constants';

/**
 * Shared spider tuning. Distances are world units and speeds are world units
 * per authoritative 60 Hz frame, matching server asteroid motion and the
 * client's GAME.MOTION_SCALE.
 */
export const SPIDER = {
  MAX_ACTIVE: 3,
  INFLUENCE_RADIUS: 280,
  SCUTTLE_SPEED: 1.25 * GAME.MOTION_SCALE,
  HUNT_SPEED: 4 * GAME.MOTION_SCALE,
  TURN_RATE: 0.04,
  HUNT_ACQUIRE_DISTANCE: 900,
  HUNT_RELEASE_DISTANCE: 1_400,
  MAX_HEALTH: DAMAGE.LASER_HIT * 3,
  BITE_DISTANCE: 44,
  HIT_RADIUS: 36,
  BITE_COOLDOWN_FRAMES: 60,
  SPAWN_INTERVAL_FRAMES: 1800,
  SPAWN_RADIUS_MIN: 720,
  SPAWN_RADIUS_MAX: 1_400,
  FURNACE_SAFE_RADIUS: 360,
  SPAWN_SAFE_RADIUS: 360,
  STARTER_SAFE_RADIUS: 720,
  WORLD_INSET: 500,
  DESPAWN_DISTANCE: 5_600,
} as const;
