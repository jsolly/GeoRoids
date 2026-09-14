import type { Position } from '../shared-types';

/** World distances use the same units as ship flight and terrain coordinates. */
export const WORLD = {
  radius: 60_000,
  sectorSize: 2_000,
  interestRadius: 2_800,
  minimapRadius: 1_800,
  depositsPerSector: 24,
} as const;

export function sectorAt(position: Position): { x: number; y: number; id: string } {
  const x = Math.floor(position.x / WORLD.sectorSize);
  const y = Math.floor(position.y / WORLD.sectorSize);
  return { x, y, id: `${x},${y}` };
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
