import { PALETTE } from '../../constants';
import { hexToRgba } from '../../utils/colorUtils';

/** Fire ink on radar and the universe map — distinct from lilac EO hardware. */
export const FURNACE_MAP_INK = PALETTE.LASER_LOCAL;
export const FURNACE_MAP_FILL_ALPHA = 0.2;
/** Radar glyph half-height in canvas pixels. */
export const MINIMAP_FURNACE_MARK_SIZE = 5;
/** Universe-map glyph half-size in screen pixels before the map scale. */
export const UNIVERSE_MAP_FURNACE_MARK_SIZE = 13;
const INNER_FLAME_MIN_SIZE = 6;

type FlamePathTarget = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
};

/**
 * Campfire silhouette in unit space, origin at the glyph center, +Y down.
 * Three upward tongues: a tall center lick and shorter side licks, with
 * valleys between them so the mark reads as fire rather than a spear.
 */
export const FURNACE_FLAME_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0.26, -0.3],
  [0.14, 0.08],
  [0.58, -0.66],
  [0.74, 0.14],
  [0.42, 0.78],
  [0.2, 1],
  [-0.2, 1],
  [-0.42, 0.78],
  [-0.74, 0.14],
  [-0.58, -0.66],
  [-0.14, 0.08],
  [-0.26, -0.3],
];

/** Inner teardrop for overview-scale marks — a single tongue, like mockup C. */
export const FURNACE_INNER_FLAME_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0.02, -0.36],
  [0.22, 0.08],
  [0.16, 0.56],
  [0, 0.72],
  [-0.16, 0.56],
  [-0.2, 0.08],
];

function addUnitOutline(
  ctx: FlamePathTarget,
  outline: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
  size: number
): void {
  const start = outline[0];
  if (start === undefined) {
    throw new Error('furnace flame outline is empty');
  }
  ctx.moveTo(x + start[0] * size, y + start[1] * size);
  for (let index = 1; index < outline.length; index += 1) {
    const point = outline[index];
    if (point === undefined) {
      throw new Error('furnace flame outline is missing a vertex');
    }
    ctx.lineTo(x + point[0] * size, y + point[1] * size);
  }
  ctx.closePath();
}

export function addFurnaceFlamePath(
  ctx: FlamePathTarget,
  x: number,
  y: number,
  size: number
): void {
  addUnitOutline(ctx, FURNACE_FLAME_OUTLINE, x, y, size);
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
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = hexToRgba(FURNACE_MAP_INK, FURNACE_MAP_FILL_ALPHA);
  ctx.strokeStyle = FURNACE_MAP_INK;
  ctx.shadowColor = FURNACE_MAP_INK;
  ctx.beginPath();
  addUnitOutline(ctx, FURNACE_FLAME_OUTLINE, x, y, size);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  if (size >= INNER_FLAME_MIN_SIZE) {
    ctx.fillStyle = hexToRgba(PALETTE.LOOT, 0.92);
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    addUnitOutline(ctx, FURNACE_INNER_FLAME_OUTLINE, x, y, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
