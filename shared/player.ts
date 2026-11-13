import type { Position } from '../shared-types';
import { sectorAt, WORLD } from './world';

function clampInsideWorld(position: Position): Position {
  const radius = Math.hypot(position.x, position.y);
  const limit = WORLD.radius - WORLD.spawnInset;
  if (radius <= limit || radius === 0) {
    return position;
  }
  const scale = limit / radius;
  return { x: position.x * scale, y: position.y * scale };
}

/** A point inside one chunk, pulled back inside the circular world. */
function randomPointInSector(x: number, y: number, random: () => number): Position {
  const minX = x * WORLD.sectorSize;
  const minY = y * WORLD.sectorSize;
  const maxX = minX + WORLD.sectorSize;
  const maxY = minY + WORLD.sectorSize;
  const inset = Math.min(WORLD.spawnInset, WORLD.sectorSize / 2 - 8);
  return clampInsideWorld({
    x: minX + inset + random() * Math.max(8, maxX - minX - inset * 2),
    y: minY + inset + random() * Math.max(8, maxY - minY - inset * 2),
  });
}

/**
 * Resume a point inside the world, else cluster near a living ally, else a
 * point in the chunk under the origin. Harvested ground stays flyable.
 */
export function chooseCrewSpawn(options: {
  allies?: readonly Position[];
  previous?: Position;
  random: () => number;
}): Position {
  const { random } = options;
  if (options.previous && Math.hypot(options.previous.x, options.previous.y) <= WORLD.radius) {
    return { x: options.previous.x, y: options.previous.y };
  }
  const ally = options.allies?.[0];
  if (ally) {
    const angle = random() * Math.PI * 2;
    const radius = random() * WORLD.spawnClusterRadius;
    return clampInsideWorld({
      x: ally.x + Math.cos(angle) * radius,
      y: ally.y + Math.sin(angle) * radius,
    });
  }
  const origin = options.previous ?? { x: 0, y: 0 };
  const sector = sectorAt(origin);
  return randomPointInSector(sector.x, sector.y, random);
}

/** Join requests and joined replies share the same UTF-8 identity limit. */
export const PLAYER_ID_MAX_BYTES = 128;
export const PLAYER_NAME_MAX_LENGTH = 20;

/** Title-screen nicknames keep letters, numbers, and spaces. */
export function sanitizePlayerName(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9 ]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, PLAYER_NAME_MAX_LENGTH);
}
