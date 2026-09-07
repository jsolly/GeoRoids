import type { Position } from '../shared-types';
import { DAMAGE, DEBUG, SHIP } from '../src/constants';
import { pointsForRoidSize } from '../src/entities/roid/roidScore';

/** Collision radius shared by human and bot ships. */
export const SHIP_COLLISION_RADIUS = SHIP.SIZE / 2;

export interface CombatantState {
  exploding: boolean;
  health: number;
  blinkCount?: number;
  spawnProtectionTimer?: number;
  respawnTimer?: number;
  type?: 'human' | 'bot';
}

export interface CombatCircle {
  id: string;
  position: Position;
  radius: number;
  immune: boolean;
}

/** True when a ship must not take or report collision / combat damage. */
export function isCombatantImmune(state: CombatantState): boolean {
  if (state.exploding || state.health <= 0 || state.respawnTimer !== undefined) {
    return true;
  }
  if (state.blinkCount !== undefined && state.blinkCount > 0) {
    return true;
  }
  if (state.spawnProtectionTimer !== undefined && state.spawnProtectionTimer > 0) {
    if (state.type === 'bot') {
      return DEBUG.BOT_PLAYER.SPAWN_PROTECTION;
    }
    return true;
  }
  return false;
}

export function circlesOverlap(
  a: Position,
  radiusA: number,
  b: Position,
  radiusB: number
): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const minDist = radiusA + radiusB;
  return dx * dx + dy * dy < minDist * minDist;
}

export function asteroidRamDamage(): number {
  return DAMAGE.LASER_HIT;
}

export function shipShipTickDamage(): number {
  return Math.max(
    1,
    Math.round(DAMAGE.PLAYER_COLLISION_PER_SECOND * (DAMAGE.PLAYER_COLLISION_INTERVAL_MS / 1000))
  );
}

export function asteroidDestroyPoints(radius: number): number {
  return pointsForRoidSize(radius);
}

export function findShipAsteroidOverlaps(
  ships: CombatCircle[],
  asteroids: Array<{ id: string; position: Position; radius: number }>
): Array<{ shipId: string; asteroidId: string }> {
  const hits: Array<{ shipId: string; asteroidId: string }> = [];
  for (const ship of ships) {
    if (ship.immune) {
      continue;
    }
    for (const asteroid of asteroids) {
      if (circlesOverlap(ship.position, ship.radius, asteroid.position, asteroid.radius)) {
        hits.push({ shipId: ship.id, asteroidId: asteroid.id });
        break;
      }
    }
  }
  return hits;
}

export function findShipShipPairs(ships: CombatCircle[]): Array<{ a: string; b: string }> {
  const pairs: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < ships.length; i++) {
    const left = ships[i];
    if (!left || left.immune) {
      continue;
    }
    for (let j = i + 1; j < ships.length; j++) {
      const right = ships[j];
      if (!right || right.immune) {
        continue;
      }
      if (circlesOverlap(left.position, left.radius, right.position, right.radius)) {
        pairs.push({ a: left.id, b: right.id });
      }
    }
  }
  return pairs;
}

export function shipShipPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function shouldApplyShipShipTick(
  lastTickMs: number | undefined,
  now: number,
  intervalMs: number = DAMAGE.PLAYER_COLLISION_INTERVAL_MS
): boolean {
  if (lastTickMs === undefined) {
    return true;
  }
  return now - lastTickMs >= intervalMs;
}

/** Client laser reports: reporter must be the shooter or the target. */
export function isAllowedLaserReporter(
  reporterId: string,
  attackerId: string,
  targetId: string
): boolean {
  return reporterId === attackerId || reporterId === targetId;
}

export function clampLaserDamage(damage: number): number {
  if (!Number.isFinite(damage) || damage <= 0) {
    return 0;
  }
  return Math.min(DAMAGE.LASER_HIT, damage);
}

export function isClientOwnedCollisionAttacker(attackerId: string): boolean {
  return attackerId === 'boundary';
}

/** Asteroid ram is resolved on the server; ignore leftover client reports. */
export function isServerOwnedRamAttacker(attackerId: string): boolean {
  return (
    attackerId === 'asteroid' ||
    attackerId.startsWith('asteroid') ||
    attackerId.startsWith('server-sat-')
  );
}
