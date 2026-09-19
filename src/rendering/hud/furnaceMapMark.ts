import { PALETTE } from '../../constants';
import { resolveGlow } from '../renderQuality';

/** Fire ink on radar and the universe map — distinct from lilac EO hardware. */
export const FURNACE_MAP_INK = PALETTE.LASER_LOCAL;
/** Radar glyph half-height in canvas pixels; pin-scale with the local ship pip. */
export const MINIMAP_FURNACE_MARK_SIZE = 4;
/** Universe-map glyph half-size in screen pixels before the map scale. */
export const UNIVERSE_MAP_FURNACE_MARK_SIZE = 10;
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
 * Traced from the three-tongue overlay: sharp left tongue, right-leaning
 * center lick, small triangular right lick, deep V valleys, rounded U base.
 * A smaller three-tongue campfire sits in the belly of the same outline.
 */
export const FURNACE_CAMPFIRE_PATH: readonly FlameCommand[] = [
  { t: 'M', x: 0, y: -1 },
  { t: 'C', x1: 0.012, y1: -0.966, x2: 0.078, y2: -0.773, x: 0.12, y: -0.66 },
  { t: 'C', x1: 0.162, y1: -0.547, x2: 0.227, y2: -0.417, x: 0.25, y: -0.32 },
  { t: 'C', x1: 0.273, y1: -0.223, x2: 0.26, y2: -0.15, x: 0.26, y: -0.08 },
  { t: 'C', x1: 0.26, y1: -0.01, x2: 0.251, y2: 0.082, x: 0.25, y: 0.1 },
  { t: 'C', x1: 0.27, y1: 0.068, x2: 0.43, y2: -0.188, x: 0.45, y: -0.22 },
  { t: 'C', x1: 0.462, y1: -0.186, x2: 0.547, y2: 0.013, x: 0.57, y: 0.12 },
  { t: 'C', x1: 0.593, y1: 0.227, x2: 0.598, y2: 0.31, x: 0.59, y: 0.42 },
  { t: 'C', x1: 0.582, y1: 0.53, x2: 0.573, y2: 0.687, x: 0.52, y: 0.78 },
  { t: 'C', x1: 0.467, y1: 0.873, x2: 0.357, y2: 0.943, x: 0.27, y: 0.98 },
  { t: 'C', x1: 0.183, y1: 1.017, x2: 0.09, y2: 1, x: 0, y: 1 },
  { t: 'C', x1: -0.09, y1: 1, x2: -0.183, y2: 1.017, x: -0.27, y: 0.98 },
  { t: 'C', x1: -0.357, y1: 0.943, x2: -0.467, y2: 0.873, x: -0.52, y: 0.78 },
  { t: 'C', x1: -0.573, y1: 0.687, x2: -0.583, y2: 0.537, x: -0.59, y: 0.42 },
  { t: 'C', x1: -0.597, y1: 0.303, x2: -0.582, y2: 0.18, x: -0.56, y: 0.08 },
  { t: 'C', x1: -0.538, y1: -0.02, x2: -0.47, y2: -0.154, x: -0.46, y: -0.18 },
  { t: 'C', x1: -0.447, y1: -0.147, x2: -0.343, y2: 0.117, x: -0.33, y: 0.15 },
  { t: 'C', x1: -0.321, y1: 0.125, x2: -0.26, y2: -0.012, x: -0.24, y: -0.1 },
  { t: 'C', x1: -0.22, y1: -0.188, x2: -0.235, y2: -0.283, x: -0.21, y: -0.38 },
  { t: 'C', x1: -0.185, y1: -0.477, x2: -0.125, y2: -0.577, x: -0.09, y: -0.68 },
  { t: 'C', x1: -0.055, y1: -0.783, x2: -0.009, y2: -0.968, x: 0, y: -1 },
];

/** Nested inner campfire from mockup C, in the same unit space as the outer path. */
export const FURNACE_INNER_CAMPFIRE_PATH: readonly FlameCommand[] = [
  { t: 'M', x: 0.04, y: -0.08 },
  { t: 'C', x1: 0.049, y1: -0.05, x2: 0.108, y2: 0.103, x: 0.13, y: 0.22 },
  { t: 'C', x1: 0.152, y1: 0.337, x2: 0.166, y2: 0.58, x: 0.17, y: 0.62 },
  { t: 'C', x1: 0.186, y1: 0.598, x2: 0.314, y2: 0.422, x: 0.33, y: 0.4 },
  { t: 'C', x1: 0.325, y1: 0.433, x2: 0.317, y2: 0.652, x: 0.28, y: 0.74 },
  { t: 'C', x1: 0.243, y1: 0.828, x2: 0.157, y2: 0.893, x: 0.11, y: 0.93 },
  { t: 'C', x1: 0.063, y1: 0.967, x2: 0.037, y2: 0.96, x: 0, y: 0.96 },
  { t: 'C', x1: -0.037, y1: 0.96, x2: -0.067, y2: 0.967, x: -0.11, y: 0.93 },
  { t: 'C', x1: -0.153, y1: 0.893, x2: -0.228, y2: 0.828, x: -0.26, y: 0.74 },
  { t: 'C', x1: -0.292, y1: 0.652, x2: -0.296, y2: 0.433, x: -0.3, y: 0.4 },
  { t: 'C', x1: -0.284, y1: 0.422, x2: -0.156, y2: 0.598, x: -0.14, y: 0.62 },
  { t: 'C', x1: -0.133, y1: 0.58, x2: -0.1, y2: 0.337, x: -0.07, y: 0.22 },
  { t: 'C', x1: -0.04, y1: 0.103, x2: 0.029, y2: -0.05, x: 0.04, y: -0.08 },
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
  ctx.shadowBlur = resolveGlow(size * 0.5);
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
