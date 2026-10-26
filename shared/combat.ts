import type { BotRole, Position } from '../shared-types';

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

export function isClientOwnedCollisionAttacker(attackerId: string): boolean {
  return attackerId === 'boundary';
}

/** World hazards the server may apply to crew hulls. */
export function isWorldHazard(attackerId: string): boolean {
  return (
    attackerId === 'asteroid' ||
    attackerId === 'boundary' ||
    attackerId === 'ricochet' ||
    attackerId === 'spider'
  );
}

/** Allied direct shots pass through hulls; opposing factions and ricochets can hit. */
export function laserDamagesShips(bounces: number, attacker?: BotRole, target?: BotRole): boolean {
  return bounces > 0 || (attacker === 'raider') !== (target === 'raider');
}
