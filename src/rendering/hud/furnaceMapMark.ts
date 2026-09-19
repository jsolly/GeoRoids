import { PALETTE } from '../../constants';

/** Fire ink on radar and the universe map — distinct from lilac EO hardware. */
export const FURNACE_MAP_INK = PALETTE.LASER_LOCAL;
/** Radar glyph half-height in canvas pixels. */
export const MINIMAP_FURNACE_MARK_SIZE = 8;
/** Universe-map glyph half-size in screen pixels before the map scale. */
export const UNIVERSE_MAP_FURNACE_MARK_SIZE = 16;
const INNER_FLAME_MIN_SIZE = 5;

type FlamePathTarget = {
  moveTo(x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  closePath(): void;
};

type FlameCommand =
  | { t: 'M'; x: number; y: number }
  | {
      t: 'C';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    };

/**
 * Mockup C campfire in unit space, origin at the glyph center, +Y down.
 * Hairline three-tongue flame: a right-leaning center lick and two side licks
 * with deep valleys, plus a rounded base. Mockup C nests a smaller three-tongue
 * campfire inside the same outline.
 */
export const FURNACE_CAMPFIRE_PATH: readonly FlameCommand[] = [
  { t: 'M', x: 0.15, y: -1 },
  { t: 'C', x1: 0.26, y1: -0.58, x2: 0.12, y2: -0.18, x: 0.18, y: 0.02 },
  { t: 'C', x1: 0.38, y1: -0.32, x2: 0.58, y2: -0.48, x: 0.56, y: -0.3 },
  { t: 'C', x1: 0.66, y1: 0.02, x2: 0.5, y2: 0.55, x: 0.2, y: 0.92 },
  { t: 'C', x1: 0.06, y1: 1.02, x2: -0.14, y2: 1.02, x: -0.24, y: 0.9 },
  { t: 'C', x1: -0.54, y1: 0.5, x2: -0.7, y2: -0.2, x: -0.48, y: -0.58 },
  { t: 'C', x1: -0.34, y1: -0.28, x2: -0.18, y2: 0.02, x: -0.08, y: 0.02 },
  { t: 'C', x1: -0.02, y1: -0.36, x2: 0.02, y2: -0.72, x: 0.15, y: -1 },
];

/** Nested inner campfire from mockup C, in the same unit space as the outer path. */
export const FURNACE_INNER_CAMPFIRE_PATH: readonly FlameCommand[] = [
  { t: 'M', x: 0.07, y: -0.36 },
  { t: 'C', x1: 0.12, y1: -0.16, x2: 0.1, y2: 0.04, x: 0.17, y: 0.08 },
  { t: 'C', x1: 0.24, y1: -0.12, x2: 0.32, y2: -0.22, x: 0.3, y: -0.08 },
  { t: 'C', x1: 0.34, y1: 0.16, x2: 0.2, y2: 0.5, x: 0.04, y: 0.6 },
  { t: 'C', x1: -0.04, y1: 0.66, x2: -0.12, y2: 0.64, x: -0.14, y: 0.56 },
  { t: 'C', x1: -0.3, y1: 0.42, x2: -0.34, y2: 0.04, x: -0.26, y: -0.16 },
  { t: 'C', x1: -0.16, y1: 0.04, x2: -0.08, y2: 0.08, x: -0.04, y: 0.08 },
  { t: 'C', x1: 0, y1: -0.12, x2: 0.02, y2: -0.26, x: 0.07, y: -0.36 },
];

function applyCampfirePath(
  ctx: FlamePathTarget,
  x: number,
  y: number,
  size: number,
  commands: readonly FlameCommand[] = FURNACE_CAMPFIRE_PATH
): void {
  for (const command of commands) {
    if (command.t === 'M') {
      ctx.moveTo(x + command.x * size, y + command.y * size);
    } else {
      ctx.bezierCurveTo(
        x + command.x1 * size,
        y + command.y1 * size,
        x + command.x2 * size,
        y + command.y2 * size,
        x + command.x * size,
        y + command.y * size
      );
    }
  }
  ctx.closePath();
}

export function addFurnaceFlamePath(
  ctx: FlamePathTarget,
  x: number,
  y: number,
  size: number
): void {
  applyCampfirePath(ctx, x, y, size);
}

export function addFurnaceInnerFlamePath(
  ctx: FlamePathTarget,
  x: number,
  y: number,
  size: number
): void {
  applyCampfirePath(ctx, x, y, size, FURNACE_INNER_CAMPFIRE_PATH);
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
  ctx.strokeStyle = FURNACE_MAP_INK;
  ctx.shadowColor = FURNACE_MAP_INK;
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  applyCampfirePath(ctx, x, y, size);
  ctx.stroke();
  if (size >= INNER_FLAME_MIN_SIZE) {
    ctx.lineWidth = size * 0.07;
    ctx.beginPath();
    applyCampfirePath(ctx, x, y, size, FURNACE_INNER_CAMPFIRE_PATH);
    ctx.stroke();
  }
  ctx.restore();
}
