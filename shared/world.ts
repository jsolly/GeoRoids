import type { Position } from '../shared-types';

/** World distances use the same units as ship flight and terrain coordinates. */
export const WORLD = {
  radius: 60_000,
  sectorSize: 2_000,
  interestRadius: 2_800,
  minimapRadius: 1_800,
  /** Current deterministic field width. Keep legacy slots stable during migrations. */
  depositsPerSector: 72,
  /** Slots present in worlds generated before the density increase. */
  legacyDepositsPerSector: 24,
  /** Persisted marker for the additive sector migration. */
  asteroidDensityVersion: 2,
  /** One-time wake-up of saved deposits for the mostly drifting field. */
  asteroidMotionVersion: 1,
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
