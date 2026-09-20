import type { Position } from '../shared-types';

interface CombatantState {
  exploding: boolean;
  health: number;
  blinkCount?: number;
  spawnProtectionTimer?: number;
  respawnTimer?: number;
  /** Map or schematic is open; the hull is frozen and must not collide. */
  overlayHold?: boolean;
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
    return true;
  }
  if (state.overlayHold === true) {
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

export function findShipAsteroidOverlaps(
  ships: CombatCircle[],
  asteroids: Array<{ id: string; position: Position; radius: number }>,
  shouldSkip?: (shipId: string, asteroidId: string) => boolean
): Array<{ shipId: string; asteroidId: string }> {
  const hits: Array<{ shipId: string; asteroidId: string }> = [];
  for (const ship of ships) {
    if (ship.immune) {
      continue;
    }
    for (const asteroid of asteroids) {
      if (shouldSkip?.(ship.id, asteroid.id)) {
        continue;
      }
      if (circlesOverlap(ship.position, ship.radius, asteroid.position, asteroid.radius)) {
        hits.push({ shipId: ship.id, asteroidId: asteroid.id });
        break;
      }
    }
  }
  return hits;
}

export function isClientOwnedCollisionAttacker(attackerId: string): boolean {
  return attackerId === 'boundary';
}

/** World hazards the server may apply to crew hulls. */
export function isWorldHazard(attackerId: string): boolean {
  return attackerId === 'asteroid' || attackerId === 'boundary' || attackerId === 'ricochet';
}

/** Direct crew shots pass through hulls; a bounce arms the bolt as a hazard. */
export function laserDamagesShips(bounces: number): boolean {
  return bounces > 0;
}
