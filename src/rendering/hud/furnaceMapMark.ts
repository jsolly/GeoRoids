import { PALETTE } from '../../constants';
import { hexToRgba } from '../../utils/colorUtils';

/** Fire ink on radar and the universe map — distinct from lilac EO hardware. */
export const FURNACE_MAP_INK = PALETTE.LASER_LOCAL;
export const FURNACE_MAP_FILL_ALPHA = 0.45;
/** Radar glyph half-height in canvas pixels; taller than the old 6×6 square. */
export const MINIMAP_FURNACE_MARK_SIZE = 4;
const INNER_FLAME_MIN_SIZE = 6;

type FlamePathTarget = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
};

/**
 * Three-tongue flame in unit space, origin at the glyph center, +Y down.
 * Side licks stay below the tip and inside the belly so the mark reads as
 * fire rather than a four-point star.
 */
export const FURNACE_FLAME_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0.2, -0.45],
  [0.38, -0.08],
  [0.16, 0.14],
  [0.5, 0.52],
  [0.28, 1],
  [0, 0.7],
  [-0.28, 1],
  [-0.5, 0.52],
  [-0.16, 0.14],
  [-0.38, -0.08],
  [-0.2, -0.45],
];

export function addFurnaceFlamePath(
  ctx: FlamePathTarget,
  x: number,
  y: number,
  size: number
): void {
  const start = FURNACE_FLAME_OUTLINE[0];
  if (start === undefined) {
    throw new Error('furnace flame outline is empty');
  }
  ctx.moveTo(x + start[0] * size, y + start[1] * size);
  for (let index = 1; index < FURNACE_FLAME_OUTLINE.length; index += 1) {
    const point = FURNACE_FLAME_OUTLINE[index];
    if (point === undefined) {
      throw new Error('furnace flame outline is missing a vertex');
    }
    ctx.lineTo(x + point[0] * size, y + point[1] * size);
  }
  ctx.closePath();
}

/** Compact fire landmark used by the local radar and the universe map. */
export function drawFurnaceMapMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number
): void {
  if (!(size > 0) || !Number.isFinite(size)) {
    return;
  }

  ctx.save();
  ctx.fillStyle = hexToRgba(FURNACE_MAP_INK, FURNACE_MAP_FILL_ALPHA);
  ctx.strokeStyle = FURNACE_MAP_INK;
  ctx.shadowColor = FURNACE_MAP_INK;
  ctx.beginPath();
  addFurnaceFlamePath(ctx, x, y, size);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  if (size >= INNER_FLAME_MIN_SIZE) {
    ctx.fillStyle = hexToRgba(PALETTE.LOOT, 0.92);
    ctx.beginPath();
    addFurnaceFlamePath(ctx, x, y + size * 0.12, size * 0.45);
    ctx.fill();
  }
  ctx.restore();
}
