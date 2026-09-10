/** Soft sides assigned on join by the factions stream. Kits only store and honor them. */
const SOFT_FACTION_IDS = ['ion', 'ember'] as const;

export type SoftFactionId = (typeof SOFT_FACTION_IDS)[number];

/** Display names stay ION / EMBER. Art is marks only — see `FACTION_MARK_PAINTERS`. */
export const SOFT_FACTION_NAMES = {
  ion: 'ION',
  ember: 'EMBER',
} as const;

function isSoftFactionId(value: unknown): value is SoftFactionId {
  return value === 'ion' || value === 'ember';
}

export function parseSoftFactionId(value: unknown): SoftFactionId | undefined {
  return isSoftFactionId(value) ? value : undefined;
}

/**
 * Same-side combat is ignored once both ships have a side.
 * Unassigned ships still take hits so current play keeps working until
 * the soft-faction join assignment lands.
 */
export function canDealCombatDamage(
  attackerFaction?: SoftFactionId,
  targetFaction?: SoftFactionId
): boolean {
  if (!attackerFaction || !targetFaction) {
    return true;
  }
  return attackerFaction !== targetFaction;
}
