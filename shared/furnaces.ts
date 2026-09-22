import type { AsteroidData, Position } from '../shared-types';

/** Respawn and fresh-join ring around the Town Square grate. */
export const TOWN_SPAWN_RADIUS = 180;

export const TOWN_HEARTH = {
  id: 'town-square',
  name: 'Town Square',
  position: { x: 0, y: 0 },
  radius: 85,
} as const;

/** The only hearth. Deliveries, respawns, and spider safety use this grate. */
export const FURNACES = [TOWN_HEARTH] satisfies {
  id: string;
  name: string;
  position: Position;
  radius: number;
}[];

export function townSquareSpawn(random: () => number): Position {
  const angle = random() * Math.PI * 2;
  return {
    x: Math.cos(angle) * TOWN_SPAWN_RADIUS,
    y: Math.sin(angle) * TOWN_SPAWN_RADIUS,
  };
}

/** A client arrival already standing on the town ring can keep that pose. */
export function isTownSquareArrival(position: Position): boolean {
  return Math.abs(Math.hypot(position.x, position.y) - TOWN_SPAWN_RADIUS) < 1;
}

const MATERIAL_POINTS = { ice: 150, metal: 300, rubble: 100 };

/** Each contributor receives the full delivery value. */
export function furnaceReward(rock: Pick<AsteroidData, 'material' | 'size'>): number {
  return MATERIAL_POINTS[rock.material ?? 'rubble'] * Math.max(1, Math.round(rock.size / 25));
}

/** Town Square is the only hearth. */
export function nearestFurnace(_position: Position): (typeof FURNACES)[number] {
  return TOWN_HEARTH;
}
