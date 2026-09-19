import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE } from '../../../src/constants';
import {
  addFurnaceFlamePath,
  drawFurnaceMapMark,
  FURNACE_FLAME_OUTLINE,
  FURNACE_MAP_FILL_ALPHA,
  FURNACE_MAP_INK,
  MINIMAP_FURNACE_MARK_SIZE,
} from '../../../src/rendering/hud/furnaceMapMark';
import { hexToRgba } from '../../../src/utils/colorUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

function recordingContext() {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('expected a 2d canvas context');
  }
  let points: Array<{ x: number; y: number }> = [];
  let closed = false;
  const strokes: Array<{
    points: Array<{ x: number; y: number }>;
    closed: boolean;
    color: string;
  }> = [];
  const fills: Array<{
    points: Array<{ x: number; y: number }>;
    closed: boolean;
    color: string;
    rectangles: Array<{ x: number; y: number; width: number; height: number }>;
  }> = [];
  let rectangles: Array<{ x: number; y: number; width: number; height: number }> = [];
  const begin = ctx.beginPath.bind(ctx);
  const move = ctx.moveTo.bind(ctx);
  const line = ctx.lineTo.bind(ctx);
  const close = ctx.closePath.bind(ctx);
  const rect = ctx.rect.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  const fill = ctx.fill.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    closed = false;
    rectangles = [];
    begin();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push({ x, y });
    move(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    points.push({ x, y });
    line(x, y);
  });
  vi.spyOn(ctx, 'closePath').mockImplementation(() => {
    closed = true;
    close();
  });
  vi.spyOn(ctx, 'rect').mockImplementation((x, y, width, height) => {
    rectangles.push({ x, y, width, height });
    rect(x, y, width, height);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation((...args) => {
    strokes.push({ points: [...points], closed, color: String(ctx.strokeStyle) });
    stroke(...args);
  });
  vi.spyOn(ctx, 'fill').mockImplementation((...args) => {
    fills.push({
      points: [...points],
      closed,
      color: String(ctx.fillStyle),
      rectangles: [...rectangles],
    });
    fill(...args);
  });
  return { ctx, strokes, fills };
}

function canvasColor(ctx: CanvasRenderingContext2D, color: string): string {
  ctx.save();
  ctx.strokeStyle = color;
  const normalized = String(ctx.strokeStyle);
  ctx.restore();
  return normalized;
}

test('a radar furnace mark is a three-tongue flame in fire ink, not a lilac square', () => {
  const { ctx, strokes, fills } = recordingContext();
  drawFurnaceMapMark(ctx, 40, 40, MINIMAP_FURNACE_MARK_SIZE);

  const flame = strokes.find((path) => path.closed);
  expect(flame).toBeDefined();
  if (!flame) {
    throw new Error('expected a closed furnace flame stroke');
  }
  expect(flame.points).toHaveLength(FURNACE_FLAME_OUTLINE.length);
  expect(flame.color).toBe(canvasColor(ctx, FURNACE_MAP_INK));
  expect(flame.color).not.toBe(canvasColor(ctx, PALETTE.SATELLITE));

  const xs = flame.points.map((point) => point.x);
  const ys = flame.points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const tip = flame.points.reduce((highest, point) => (point.y < highest.y ? point : highest));
  expect(height).toBeGreaterThan(width);
  expect(tip).toEqual({ x: 40, y: 40 - MINIMAP_FURNACE_MARK_SIZE });
  expect(fills.some((path) => path.rectangles.length > 0)).toBe(false);
  expect(
    fills.some(
      (path) => path.color === canvasColor(ctx, hexToRgba(FURNACE_MAP_INK, FURNACE_MAP_FILL_ALPHA))
    )
  ).toBe(true);
});

test('a universe-map furnace mark keeps a cream inner tongue inside the outer flame', () => {
  const { ctx, fills } = recordingContext();
  drawFurnaceMapMark(ctx, 40, 40, 11);

  const outer = fills.find(
    (path) => path.color === canvasColor(ctx, hexToRgba(FURNACE_MAP_INK, FURNACE_MAP_FILL_ALPHA))
  );
  const inner = fills.find(
    (path) => path.color === canvasColor(ctx, hexToRgba(PALETTE.LOOT, 0.92))
  );
  expect(outer?.closed).toBe(true);
  expect(inner?.closed).toBe(true);
  if (!outer || !inner) {
    throw new Error('expected outer and inner furnace flame fills');
  }
  const outerSpan =
    Math.max(...outer.points.map((point) => point.y)) -
    Math.min(...outer.points.map((point) => point.y));
  const innerSpan =
    Math.max(...inner.points.map((point) => point.y)) -
    Math.min(...inner.points.map((point) => point.y));
  expect(innerSpan).toBeLessThan(outerSpan);
});

test('the shared flame path stays a closed tongue silhouette', () => {
  const points: Array<{ x: number; y: number }> = [];
  addFurnaceFlamePath(
    {
      moveTo(x, y) {
        points.push({ x, y });
      },
      lineTo(x, y) {
        points.push({ x, y });
      },
      closePath() {},
    },
    0,
    0,
    1
  );
  expect(points).toHaveLength(FURNACE_FLAME_OUTLINE.length);
  expect(points[0]).toEqual({ x: 0, y: -1 });
});
