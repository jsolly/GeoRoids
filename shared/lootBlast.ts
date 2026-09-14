import type { Position, Velocity } from '../shared-types';
import { GAME } from '../src/constants';

/**
 * Shoot-a-drop blast (GH #313 / Todoist destroy-drop).
 * Applies to every loot kind.
 */
export const LOOT_BLAST = {
  RADIUS: 80,
  DAMAGE: 40,
  PUSH: 4 * GAME.MOTION_SCALE,
  /** Matches AsteroidManager "small" spawn band (size < 25). */
  SMALL_ROID_MAX: 24,
  /** Generous laser reach so a real shot can arm a drop without map-wide detonates. */
  ARM_RANGE: 900,
} as const;

export function inBlastRadius(origin: Position, target: Position, extraRadius = 0): boolean {
  const reach = LOOT_BLAST.RADIUS + extraRadius;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  return dx * dx + dy * dy <= reach * reach;
}

export function inLootArmRange(shooter: Position, loot: Position): boolean {
  const dx = loot.x - shooter.x;
  const dy = loot.y - shooter.y;
  return dx * dx + dy * dy <= LOOT_BLAST.ARM_RANGE * LOOT_BLAST.ARM_RANGE;
}

export function blastPush(origin: Position, target: Position): Velocity {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    return { x: LOOT_BLAST.PUSH, y: 0 };
  }
  return {
    x: (dx / dist) * LOOT_BLAST.PUSH,
    y: (dy / dist) * LOOT_BLAST.PUSH,
  };
}

export function isSmallRoid(size: number): boolean {
  return size <= LOOT_BLAST.SMALL_ROID_MAX;
}
