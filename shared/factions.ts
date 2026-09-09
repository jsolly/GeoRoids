import type { FactionId } from '../shared-types';

/**
 * Mark/label hexes only — never hull stroke.
 * #5EEAD4 (local) and #FB923C (bot) stay ownership/role colors in PALETTE.
 */
export const FACTION_COLORS: Record<FactionId, string> = {
  ion: '#A8A0C8',
  ember: '#D4B896',
};

export const FACTION_LABELS: Record<FactionId, string> = {
  ion: 'ION',
  ember: 'EMBER',
};

export function getSideColor(faction: FactionId): string {
  return FACTION_COLORS[faction];
}

export function countFactions(
  factions: readonly (FactionId | undefined)[]
): Record<FactionId, number> {
  const counts: Record<FactionId, number> = { ion: 0, ember: 0 };
  for (const faction of factions) {
    if (faction === 'ion' || faction === 'ember') {
      counts[faction] += 1;
    }
  }
  return counts;
}

/**
 * Assign the smaller side. Ties fill ion first so the next join lands on ember.
 * Only reads `faction` — ship kits (Dart/Hauler/Warden/Skirmisher/Quake) stay
 * a parallel stream and never affect side assignment.
 */
export function pickBalancedFaction(existing: readonly (FactionId | undefined)[]): FactionId {
  const { ion, ember } = countFactions(existing);
  if (ion < ember) {
    return 'ion';
  }
  if (ember < ion) {
    return 'ember';
  }
  return 'ion';
}

/** Balance from any ship-shaped object; kit / kitId fields are ignored. */
export function pickBalancedFactionFromShips(
  ships: readonly { faction?: FactionId; factionId?: FactionId; kit?: unknown; kitId?: unknown }[]
): FactionId {
  return pickBalancedFaction(ships.map((ship) => ship.faction ?? ship.factionId));
}

export function areAllied(a: FactionId | undefined, b: FactionId | undefined): boolean {
  return a !== undefined && b !== undefined && a === b;
}

export function areHostile(a: FactionId | undefined, b: FactionId | undefined): boolean {
  return !areAllied(a, b);
}

export function isEnvironmentAttacker(attackerId: string): boolean {
  return attackerId === 'asteroid' || attackerId === 'boundary';
}

/** Environment always hits. Same-side ships never do. Unknown attacker stays hostile. */
export function canApplyCombatDamage(
  attackerId: string,
  attackerFaction: FactionId | undefined,
  targetFaction: FactionId | undefined
): boolean {
  if (isEnvironmentAttacker(attackerId)) {
    return true;
  }
  return areHostile(attackerFaction, targetFaction);
}
