import type { Position } from '../shared-types';

/** World distances use the same units as ship flight and terrain coordinates. */
export const WORLD = {
  radius: 60_000,
  sectorSize: 2_000,
  interestRadius: 2_800,
  minimapRadius: 1_800,
  depositsPerSector: 24,
  /** Saved worlds with a different generation reset instead of loading stale progress. */
  generation: 1,
  spawnClusterRadius: 150,
  spawnInset: 220,
} as const;

const SCORE_SEASON_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

/** UTC calendar month used to wipe scores and the shared world. */
export function utcScoreSeason(nowMs: number): string {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('Score season requires a finite non-negative time');
  }
  const date = new Date(nowMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isScoreSeason(value: unknown): value is string {
  return typeof value === 'string' && SCORE_SEASON_PATTERN.test(value);
}

const SECTOR_ID_PATTERN = /^-?\d+,-?\d+$/u;

export function sectorId(x: number, y: number): string {
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
