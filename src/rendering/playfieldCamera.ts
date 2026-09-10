import type { Position } from '../../shared-types';

export type PlayfieldSize = Readonly<{ width: number; height: number }>;
export type PlayfieldRock = {
  position: Position;
  r?: number;
  angle?: number;
  pendingDestruction?: boolean;
};

const projectScratch = { x: 0, y: 0 };

/** Single close/play scale used by the renderer; the minimap is the wide view. */
export const PLAYFIELD_CLOSE_SCALE = 1;

/** Ship-centered projection. Scale 1 matches today's 1:1 camera. */
export function projectWorldToScreenInto(
  out: { x: number; y: number },
  world: Position,
  ship: Position,
  viewport: PlayfieldSize,
  scale = PLAYFIELD_CLOSE_SCALE
): { x: number; y: number } {
  out.x = viewport.width / 2 + (world.x - ship.x) * scale;
  out.y = viewport.height / 2 + (world.y - ship.y) * scale;
  return out;
}

function isRockOnCanvas(
  world: Position,
  ship: Position,
  viewport: PlayfieldSize,
  scale = PLAYFIELD_CLOSE_SCALE,
  margin = 0
): boolean {
  const screen = projectWorldToScreenInto(projectScratch, world, ship, viewport, scale);
  return (
    screen.x >= -margin &&
    screen.x <= viewport.width + margin &&
    screen.y >= -margin &&
    screen.y <= viewport.height + margin
  );
}

function isDrawablePlayfieldRock(roid: PlayfieldRock): boolean {
  if (roid.pendingDestruction) {
    return false;
  }
  if (!Number.isFinite(roid.position.x) || !Number.isFinite(roid.position.y)) {
    return false;
  }
  if (roid.r !== undefined && !Number.isFinite(roid.r)) {
    return false;
  }
  if (roid.angle !== undefined && !Number.isFinite(roid.angle)) {
    return false;
  }
  return true;
}

export function countRocksOnCanvas(
  roids: readonly PlayfieldRock[],
  ship: Position,
  viewport: PlayfieldSize,
  scale = PLAYFIELD_CLOSE_SCALE,
  margin = 0
): number {
  let count = 0;
  for (const roid of roids) {
    if (isRockOnCanvas(roid.position, ship, viewport, scale, margin)) {
      count += 1;
    }
  }
  return count;
}

/** PO / QA bar: if radar has dots, the playfield must show at least one rock. */
export function radarBeltVisibleOnPlayfield(
  roids: readonly PlayfieldRock[],
  ship: Position,
  viewport: PlayfieldSize
): boolean {
  let drawable = 0;
  for (const roid of roids) {
    if (isDrawablePlayfieldRock(roid)) {
      drawable += 1;
    }
  }
  if (drawable === 0) {
    return false;
  }
  const scale = PLAYFIELD_CLOSE_SCALE;
  for (const roid of roids) {
    if (isDrawablePlayfieldRock(roid) && isRockOnCanvas(roid.position, ship, viewport, scale)) {
      return true;
    }
  }
  return false;
}

const EMPTY_OFFSETS = [1];

/** Stroke path for a roid. Empty offsets still paint a circle so radar dots are not holes. */
export function drawingOffsets(offsets: readonly number[]): readonly number[] {
  return offsets.length > 0 ? offsets : EMPTY_OFFSETS;
}
