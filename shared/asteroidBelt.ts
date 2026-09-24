import type { AsteroidData, Position } from '../shared-types';
import { MATERIAL_OUTLINES } from './asteroidMaterials';

/** A fixed destination east of launch, with clear lanes through three rich rows. */
export const ASTEROID_BELT = {
  radius: 4_500,
  halfAngle: 0.75,
  columns: 40,
  rows: 3,
  rowSpacing: 190,
  recoveryMs: 5 * 60_000,
  warningMs: 10_000,
  removalDistance: 240,
} as const;

export interface BeltSlotState {
  slot: number;
  generation: number;
  recoverAt: number | null;
}

export interface BeltRecoveryWarning {
  slot: number;
  position: Position;
  size: number;
  recoverAt: number;
}

/** Gaps remain gaps after every recovery cycle. */
export function beltSlots(): number[] {
  return Array.from(
    { length: ASTEROID_BELT.columns * ASTEROID_BELT.rows },
    (_, slot) => slot
  ).filter((slot) => ![9, 10, 29, 30].includes(Math.floor(slot / ASTEROID_BELT.rows)));
}

const BELT_ID = /^belt--?\d+-(\d+)-\d+$/u;

export function beltSlotForAsteroid(id: string): number | undefined {
  const match = BELT_ID.exec(id);
  return match ? Number(match[1]) : undefined;
}

export function beltSlotPosition(slot: number): Position {
  const column = Math.floor(slot / ASTEROID_BELT.rows);
  const row = slot % ASTEROID_BELT.rows;
  const angle =
    -ASTEROID_BELT.halfAngle + (column / (ASTEROID_BELT.columns - 1)) * 2 * ASTEROID_BELT.halfAngle;
  const radius = ASTEROID_BELT.radius + (row - 1) * ASTEROID_BELT.rowSpacing;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function beltAsteroid(seed: number, slot: number, generation: number): AsteroidData {
  const variation = ((Math.imul(seed ^ slot, 1597334677) >>> 0) % 1000) / 1000;
  const size = 72 + variation * 28;
  return {
    id: `belt-${seed}-${slot}-${generation}`,
    position: beltSlotPosition(slot),
    velocity: { x: 0, y: 0 },
    size,
    material: 'metal',
    health: 150,
    maxHealth: 150,
    rotation: variation * Math.PI * 2,
    angularVelocity: 0,
    jaggedness: 0.25,
    vertices: MATERIAL_OUTLINES.metal.length,
    offsets: [...MATERIAL_OUTLINES.metal],
  };
}

/** Validate the entire finite timer ledger at the disk boundary. */
export function readBeltState(value: unknown): BeltSlotState[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Saved asteroid belt is invalid');
  }
  const slots = new Set(beltSlots());
  const result: BeltSlotState[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('slot' in entry) ||
      typeof entry.slot !== 'number' ||
      !slots.delete(entry.slot) ||
      !('generation' in entry) ||
      typeof entry.generation !== 'number' ||
      !Number.isSafeInteger(entry.generation) ||
      entry.generation < 0 ||
      !('recoverAt' in entry) ||
      (entry.recoverAt !== null &&
        (typeof entry.recoverAt !== 'number' ||
          !Number.isFinite(entry.recoverAt) ||
          entry.recoverAt < 0))
    ) {
      throw new Error('Saved asteroid belt is invalid');
    }
    result.push({ slot: entry.slot, generation: entry.generation, recoverAt: entry.recoverAt });
  }
  if (slots.size !== 0) {
    throw new Error('Saved asteroid belt is incomplete');
  }
  return result;
}
