import type { Position } from '../shared-types';

/** World distances use the same units as ship flight and terrain coordinates. */
export const WORLD = {
  radius: 60_000,
  sectorSize: 2_000,
  interestRadius: 2_800,
  minimapRadius: 1_800,
  /**
   * Snapshots carry asteroids only inside this circle: the minimap radar plus
   * a margin for rocks crossing its edge. Sectors still wake at interestRadius.
   */
  asteroidInterestRadius: 1_950,
  /** Awake sectors whose rock set is unchanged persist drift every Nth checkpoint. */
  driftFlushCheckpoints: 5,
  /** Saved worlds with a different generation reset instead of loading stale progress. */
  generation: 1,
  spawnClusterRadius: 150,
  spawnInset: 220,
} as const;

const SECTOR_ID_PATTERN = /^-?\d+,-?\d+$/u;

function sectorId(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseSectorId(id: string): { x: number; y: number } | null {
  if (!SECTOR_ID_PATTERN.test(id)) {
    return null;
  }
  const [rawX, rawY] = id.split(',');
  const x = Number(rawX);
  const y = Number(rawY);
  if (
    rawX === undefined ||
    rawY === undefined ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    sectorId(x, y) !== id
  ) {
    return null;
  }
  return { x, y };
}

export function sectorAt(position: Position): { x: number; y: number; id: string } {
  const x = Math.floor(position.x / WORLD.sectorSize);
  const y = Math.floor(position.y / WORLD.sectorSize);
  return { x, y, id: sectorId(x, y) };
}

export function nearbyWorldRows<T extends { position: Position }>(
  rows: readonly T[],
  center: Position
): T[] {
  return rows.filter(
    (row) =>
      Math.abs(row.position.x - center.x) <= WORLD.interestRadius &&
      Math.abs(row.position.y - center.y) <= WORLD.interestRadius
  );
}

/** Asteroids a client can draw on its flight view or minimap radar. */
export function nearbyAsteroidRows<T extends { position: Position }>(
  rows: readonly T[],
  center: Position
): T[] {
  return rows.filter(
    (row) =>
      Math.hypot(row.position.x - center.x, row.position.y - center.y) <=
      WORLD.asteroidInterestRadius
  );
}
