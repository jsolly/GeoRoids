import type { AsteroidData, AsteroidMaterial, SettlementState, ShipKitId } from '../shared-types';

export const ECONOMY = {
  scoutCapacity: 500,
  haulerCapacity: 1500,
  deathLootFrames: 120 * 60,
} as const;
export const RESOURCES = ['ice', 'metal', 'rubble', 'crystal'] as const;
export function cargoCapacity(kit?: ShipKitId) {
  return kit === 'hauler' ? ECONOMY.haulerCapacity : ECONOMY.scoutCapacity;
}
export function emptySettlement(): SettlementState {
  return { level: 1, points: 0, resources: { ice: 0, metal: 0, rubble: 0, crystal: 0 } };
}
/** Requirements for the next tier. Surplus carries forward after construction. */
export function settlementRecipe(level: number): Omit<SettlementState, 'level'> {
  return {
    points: level * 2000,
    resources: { ice: level * 40, metal: level * 60, rubble: level * 80, crystal: level * 20 },
  };
}
export function advanceSettlement(state: SettlementState): SettlementState {
  const next = { ...state, resources: { ...state.resources } };
  for (;;) {
    const recipe = settlementRecipe(next.level);
    if (
      next.points < recipe.points ||
      RESOURCES.some((key) => next.resources[key] < recipe.resources[key])
    ) {
      return next;
    }
    next.points -= recipe.points;
    for (const key of RESOURCES) {
      next.resources[key] -= recipe.resources[key];
    }
    next.level++;
  }
}
export function settlementProgress(state: SettlementState): number {
  const recipe = settlementRecipe(state.level);
  return (
    (Math.min(1, state.points / recipe.points) +
      RESOURCES.reduce(
        (sum, key) => sum + Math.min(1, state.resources[key] / recipe.resources[key]),
        0
      )) /
    5
  );
}
export function validSettlement(value: unknown): value is SettlementState {
  if (
    !value ||
    typeof value !== 'object' ||
    !('level' in value) ||
    !('points' in value) ||
    !('resources' in value)
  ) {
    return false;
  }
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const resources = value.resources;
  return (
    valid(value.level) &&
    value.level > 0 &&
    valid(value.points) &&
    resources !== null &&
    typeof resources === 'object' &&
    RESOURCES.every((key) => key in resources && valid(Reflect.get(resources, key)))
  );
}
/** Stable for old saves too; most rocks are barren regardless of their hull material. */
export function oreResource(
  rock: Pick<AsteroidData, 'id' | 'material' | 'ore'>
): AsteroidMaterial | null {
  if (rock.ore !== undefined) {
    return rock.ore;
  }
  let hash = 2166136261;
  for (const char of rock.id) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) % 3 === 0 ? (rock.material ?? 'rubble') : null;
}
/** Area-scaled output means breaking a rock always sacrifices ore. */
export function oreYield(rock: Pick<AsteroidData, 'size'>): number {
  return Math.max(0, Math.floor((rock.size / 25) ** 2 * 10));
}
