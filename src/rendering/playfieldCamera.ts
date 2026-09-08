import type { Position } from '../../shared-types';

export type PlayfieldSize = { width: number; height: number };

const projectScratch = { x: 0, y: 0 };

/** Single close/play scale used by the renderer; the minimap is the wide view. */
export const PLAYFIELD_CLOSE_SCALE = 1;

/** Ship-centered projection. Scale 1 matches today's 1:1 camera. */
export function projectWorldToScreenInto(
  out: { x: number; y: number },
  world: Position,
  ship: Position,
  canvas: PlayfieldSize,
  scale = 1
): { x: number; y: number } {
  out.x = canvas.width / 2 + (world.x - ship.x) * scale;
  out.y = canvas.height / 2 + (world.y - ship.y) * scale;
  return out;
}

export function projectWorldToScreen(
  world: Position,
  ship: Position,
  canvas: PlayfieldSize,
  scale = 1
): { x: number; y: number } {
  const projected = projectWorldToScreenInto(projectScratch, world, ship, canvas, scale);
  return { x: projected.x, y: projected.y };
}

export function isRockOnCanvas(
  world: Position,
  ship: Position,
  canvas: PlayfieldSize,
  scale = 1,
  margin = 0
): boolean {
  const screen = projectWorldToScreenInto(projectScratch, world, ship, canvas, scale);
  return (
    screen.x >= -margin &&
    screen.x <= canvas.width + margin &&
    screen.y >= -margin &&
    screen.y <= canvas.height + margin
  );
}

export function countRocksOnCanvas(
  roids: ReadonlyArray<{ position: Position }>,
  ship: Position,
  canvas: PlayfieldSize,
  scale = 1,
  margin = 0
): number {
  let count = 0;
  for (const roid of roids) {
    if (isRockOnCanvas(roid.position, ship, canvas, scale, margin)) {
      count += 1;
    }
  }
  return count;
}

const EMPTY_OFFSETS = [1];

/** Keep an asteroid's stroke visible when its snapshot has no radial offsets. */
export function drawingOffsets(offsets: readonly number[]): readonly number[] {
  return offsets.length > 0 ? offsets : EMPTY_OFFSETS;
}
