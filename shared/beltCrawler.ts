import type { AsteroidData } from '../shared-types';
import { beltSlotForAsteroid } from './asteroidBelt';
import { DAMAGE, GAME } from './constants/gameplay';

/** Surface predators stay anchored even while reaching out to bite. */
export const BELT_CRAWLER = {
  MAX_ACTIVE: 96,
  /** Every sixth belt slot is born carrying one crawler. */
  NATIVE_SLOT_STRIDE: 6,
  ESCAPE_DISTANCE: 300,
  ESCAPE_FRAMES: 36,
  PURSUIT_PROGRESS: 40,
  PURSUIT_REPLAN_FRAMES: 15,
  MAX_HEALTH: DAMAGE.LASER_HIT,
  HIT_RADIUS: 12,
  SURFACE_OFFSET: 14,
  CRAWL_SPEED: 2.2 * GAME.MOTION_SCALE,
  ACQUIRE_DISTANCE: 700,
  LUNGE_REACH: 130,
  WINDUP_FRAMES: 42,
  LUNGE_FRAMES: 18,
  RECOVERY_FRAMES: 54,
} as const;

export function nativeCrawlerSlot(id: string): boolean {
  const slot = beltSlotForAsteroid(id);
  return slot !== undefined && slot % BELT_CRAWLER.NATIVE_SLOT_STRIDE === 0;
}

/**
 * The rocks a crawler frame must visit: a native slot, or one already carrying
 * crawler rows from an earlier frame, a transfer, or a saved world. Everything
 * else in the belt has no crawler to advance.
 */
export function hostsBeltCrawlers(rock: Pick<AsteroidData, 'id' | 'beltCrawlerIds'>): boolean {
  return rock.beltCrawlerIds !== undefined || nativeCrawlerSlot(rock.id);
}
