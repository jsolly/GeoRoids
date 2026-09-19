import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, VISUAL } from '../../../src/constants';
import {
  addFurnaceFlamePath,
  addFurnaceInnerFlamePath,
  drawFurnaceMapMark,
  FURNACE_CAMPFIRE_PATH,
  FURNACE_DISTANT_FLAME_PATH,
  FURNACE_INNER_CAMPFIRE_PATH,
  FURNACE_MAP_CAMPFIRE_ZOOM,
  FURNACE_MAP_FAR_ZOOM,
  FURNACE_MAP_INK,
  MINIMAP_FURNACE_MARK_SIZE,
  UNIVERSE_MAP_LANDMARK_FAR_SIZE,
  UNIVERSE_MAP_LANDMARK_SIZE,
  universeMapFurnaceMarkAppearance,
  universeMapMarkScreenSize,
} from '../../../src/rendering/hud/furnaceMapMark';

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
    curves: number;
  }> = [];
  const fills: Array<{
    points: Array<{ x: number; y: number }>;
    closed: boolean;
    color: string;
    rectangles: Array<{ x: number; y: number; width: number; height: number }>;
  }> = [];
  let rectangles: Array<{ x: number; y: number; width: number; height: number }> = [];
  let curves = 0;
  const begin = ctx.beginPath.bind(ctx);
  const move = ctx.moveTo.bind(ctx);
  const bezier = ctx.bezierCurveTo.bind(ctx);
  const close = ctx.closePath.bind(ctx);
  const rect = ctx.rect.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  const fill = ctx.fill.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    closed = false;
    rectangles = [];
    curves = 0;
    begin();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push({ x, y });
    move(x, y);
  });
  vi.spyOn(ctx, 'bezierCurveTo').mockImplementation((cp1x, cp1y, cp2x, cp2y, x, y) => {
    points.push({ x, y });
    curves += 1;
    bezier(cp1x, cp1y, cp2x, cp2y, x, y);
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
    strokes.push({ points: [...points], closed, color: String(ctx.strokeStyle), curves });
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

test('furnace HUD marks stay pin-scale with the ship pip and other map assets', () => {
  expect(MINIMAP_FURNACE_MARK_SIZE).toBeLessThanOrEqual(VISUAL.MINIMAP_LOCAL_SIZE);
  expect(MINIMAP_FURNACE_MARK_SIZE * 2).toBeLessThan(VISUAL.MINIMAP_SIZE / 6);
  const nearby = universeMapFurnaceMarkAppearance(FURNACE_MAP_CAMPFIRE_ZOOM);
  const distant = universeMapFurnaceMarkAppearance(FURNACE_MAP_FAR_ZOOM);
  const close = universeMapFurnaceMarkAppearance(FURNACE_MAP_CAMPFIRE_ZOOM * 2);
  expect(nearby.lod).toBe('campfire');
  expect(distant.lod).toBe('distant');
  expect(close.lod).toBe('campfire');
  expect(nearby.screen).toBe(UNIVERSE_MAP_LANDMARK_SIZE);
  expect(distant.screen).toBe(UNIVERSE_MAP_LANDMARK_FAR_SIZE);
  expect(distant.screen).toBeLessThan(nearby.screen);
  expect(close.screen).toBe(nearby.screen);
  expect(universeMapMarkScreenSize(UNIVERSE_MAP_LANDMARK_SIZE, 12.5)).toBe(8.5);
  const shipNear = 18;
  expect(universeMapMarkScreenSize(shipNear, FURNACE_MAP_CAMPFIRE_ZOOM)).toBe(shipNear);
  expect(universeMapMarkScreenSize(shipNear, FURNACE_MAP_CAMPFIRE_ZOOM * 2)).toBe(shipNear);
  expect(universeMapMarkScreenSize(shipNear, FURNACE_MAP_FAR_ZOOM) / shipNear).toBeCloseTo(
    UNIVERSE_MAP_LANDMARK_FAR_SIZE / UNIVERSE_MAP_LANDMARK_SIZE
  );
});

test('a radar furnace mark is a hairline three-tongue campfire in fire ink, not a lilac square', () => {
  const { ctx, strokes, fills } = recordingContext();
  drawFurnaceMapMark(ctx, 40, 40, MINIMAP_FURNACE_MARK_SIZE);

  const flame = strokes.find((path) => path.closed);
  expect(flame).toBeDefined();
  if (!flame) {
    throw new Error('expected a closed furnace flame stroke');
  }
  expect(flame.curves).toBe(FURNACE_CAMPFIRE_PATH.filter((command) => command.t === 'C').length);
  expect(flame.color).toBe(canvasColor(ctx, FURNACE_MAP_INK));
  expect(flame.color).not.toBe(canvasColor(ctx, PALETTE.SATELLITE));

  const xs = flame.points.map((point) => point.x);
  const ys = flame.points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const tip = flame.points.reduce((highest, point) => (point.y < highest.y ? point : highest));
  expect(height).toBeGreaterThan(width);
  expect(tip.x).toBeGreaterThanOrEqual(40);
  expect(tip.y).toBeCloseTo(40 - MINIMAP_FURNACE_MARK_SIZE, 5);
  expect(Math.min(...xs)).toBeLessThan(40 - MINIMAP_FURNACE_MARK_SIZE * 0.4);
  expect(Math.max(...xs)).toBeGreaterThan(40 + MINIMAP_FURNACE_MARK_SIZE * 0.4);
  expect(fills).toEqual([]);
});

test('a zoomed-out universe-map furnace mark is a single-tongue flame pin', () => {
  const { ctx, strokes, fills } = recordingContext();
  const distant = universeMapFurnaceMarkAppearance(1);
  drawFurnaceMapMark(ctx, 40, 40, distant.screen, distant.lod);

  const campfires = strokes.filter(
    (path) => path.closed && path.color === canvasColor(ctx, FURNACE_MAP_INK)
  );
  expect(campfires).toHaveLength(1);
  const pin = campfires[0];
  if (!pin) {
    throw new Error('expected a distant furnace flame pin');
  }
  expect(pin.curves).toBe(FURNACE_DISTANT_FLAME_PATH.filter((command) => command.t === 'C').length);
  expect(pin.curves).toBeLessThan(
    FURNACE_CAMPFIRE_PATH.filter((command) => command.t === 'C').length
  );
  const tip = pin.points.reduce((highest, point) => (point.y < highest.y ? point : highest));
  expect(tip.x).toBeGreaterThanOrEqual(40);
  expect(tip.y).toBeCloseTo(40 - distant.screen, 5);
  expect(fills).toEqual([]);
});

test('a universe-map furnace mark nests a smaller inner campfire in the same fire ink', () => {
  const { ctx, strokes, fills } = recordingContext();
  drawFurnaceMapMark(ctx, 40, 40, UNIVERSE_MAP_LANDMARK_SIZE);

  const campfires = strokes.filter(
    (path) => path.closed && path.color === canvasColor(ctx, FURNACE_MAP_INK)
  );
  expect(campfires).toHaveLength(2);
  const outer = campfires[0];
  const inner = campfires[1];
  if (!outer || !inner) {
    throw new Error('expected outer and inner furnace campfire strokes');
  }
  expect(inner.curves).toBe(
    FURNACE_INNER_CAMPFIRE_PATH.filter((command) => command.t === 'C').length
  );
  const outerSpan =
    Math.max(...outer.points.map((point) => point.y)) -
    Math.min(...outer.points.map((point) => point.y));
  const innerSpan =
    Math.max(...inner.points.map((point) => point.y)) -
    Math.min(...inner.points.map((point) => point.y));
  expect(innerSpan).toBeLessThan(outerSpan);
  expect(fills).toEqual([]);
});

test('the shared flame path is a closed right-leaning campfire', () => {
  const points: Array<{ x: number; y: number }> = [];
  let curves = 0;
  addFurnaceFlamePath(
    {
      moveTo(x, y) {
        points.push({ x, y });
      },
      bezierCurveTo(_cp1x, _cp1y, _cp2x, _cp2y, x, y) {
        curves += 1;
        points.push({ x, y });
      },
      closePath() {},
    },
    0,
    0,
    1
  );
  expect(curves).toBe(FURNACE_CAMPFIRE_PATH.filter((command) => command.t === 'C').length);
  expect(points[0]?.x).toBeGreaterThanOrEqual(0);
  expect(points[0]?.y).toBe(-1);
  expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(0.4);
  const innerPoints: Array<{ x: number; y: number }> = [];
  addFurnaceInnerFlamePath(
    {
      moveTo(x, y) {
        innerPoints.push({ x, y });
      },
      bezierCurveTo(_cp1x, _cp1y, _cp2x, _cp2y, x, y) {
        innerPoints.push({ x, y });
      },
      closePath() {},
    },
    0,
    0,
    1
  );
  const outerHeight =
    Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  const innerHeight =
    Math.max(...innerPoints.map((point) => point.y)) -
    Math.min(...innerPoints.map((point) => point.y));
  expect(innerHeight).toBeLessThan(outerHeight);
});
