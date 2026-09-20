import type { AsteroidData, Position } from '../shared-types';
import { sectorAt, WORLD } from './world';

const orbit = 660;
export const FURNACES = [
  { id: 'north', name: 'North Works', position: { x: 0, y: -orbit }, radius: 85 },
  {
    id: 'southeast',
    name: 'Southeast Works',
    position: { x: orbit * 0.866, y: orbit * 0.5 },
    radius: 85,
  },
  {
    id: 'southwest',
    name: 'Southwest Works',
    position: { x: -orbit * 0.866, y: orbit * 0.5 },
    radius: 85,
  },
] satisfies { id: string; name: string; position: Position; radius: number }[];

const REGIONAL_SPACING = WORLD.sectorSize * 2;
const SECTOR_CENTER = WORLD.sectorSize / 2;

// Fixed landmarks remain discoverable even when their surrounding sector is asleep.
// Sit them in sector interiors so a towed rock can swing in from any side.
for (let row = -14; row <= 14; row++) {
  for (let col = -14; col <= 14; col++) {
    if (col === 0 && row === 0) {
      continue;
    }
    const position = {
      x: col * REGIONAL_SPACING + SECTOR_CENTER,
      y: row * REGIONAL_SPACING + SECTOR_CENTER,
    };
    if (Math.hypot(position.x, position.y) > WORLD.radius - WORLD.sectorSize) {
      continue;
    }
    FURNACES.push({ id: `works-${col}-${row}`, name: `Works ${col}:${row}`, position, radius: 85 });
  }
}

const FURNACE_SECTOR_IDS = new Set(FURNACES.map((site) => sectorAt(site.position).id));

/** Works yards stay flyable; mapping them must not raise completed-sector walls. */
export function isFurnaceSector(id: string): boolean {
  return FURNACE_SECTOR_IDS.has(id);
}

const MATERIAL_POINTS = { ice: 150, metal: 300, rubble: 100 };

/** Each contributor receives the full delivery value. */
export function furnaceReward(rock: Pick<AsteroidData, 'material' | 'size'>): number {
  return MATERIAL_POINTS[rock.material ?? 'rubble'] * Math.max(1, Math.round(rock.size / 25));
}

/** Furnace landmarks are fixed and nonempty, independent of explored sectors. */
export function nearestFurnace(position: Position): (typeof FURNACES)[number] {
  return FURNACES.reduce((nearest, site) =>
    Math.hypot(position.x - site.position.x, position.y - site.position.y) <
    Math.hypot(position.x - nearest.position.x, position.y - nearest.position.y)
      ? site
      : nearest
  );
}
