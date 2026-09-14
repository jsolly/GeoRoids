import type { AsteroidData, Position } from '../shared-types';
import { WORLD } from './world';

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

// Fixed landmarks remain discoverable even when their surrounding sector is asleep.
for (let row = -14; row <= 14; row++) {
  for (let col = -14; col <= 14; col++) {
    if (col === 0 && row === 0) {
      continue;
    }
    const position = { x: col * 4_000, y: row * 4_000 };
    if (Math.hypot(position.x, position.y) > WORLD.radius - 2_000) {
      continue;
    }
    FURNACES.push({ id: `works-${col}-${row}`, name: `Works ${col}:${row}`, position, radius: 85 });
  }
}

const MATERIAL_POINTS = { ice: 150, metal: 300, rubble: 100 };

/** Each contributor receives the full delivery value. */
export function furnaceReward(rock: Pick<AsteroidData, 'material' | 'size'>): number {
  return MATERIAL_POINTS[rock.material ?? 'rubble'] * Math.max(1, Math.round(rock.size / 25));
}
