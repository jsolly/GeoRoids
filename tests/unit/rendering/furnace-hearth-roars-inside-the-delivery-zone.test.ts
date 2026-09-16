import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, VISUAL } from '../../../src/constants';
import { canvasManager } from '../../../src/rendering/canvas';
import { drawFurnaceArtwork } from '../../../src/rendering/furnaceRenderer';
import { hexToRgba } from '../../../src/utils/colorUtils';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};
let canvas: HTMLCanvasElement | undefined;
let previousCanvas: HTMLElement | null = null;

afterEach(() => {
  canvasManager.destroy();
  if (previousCanvas) {
    canvas?.replaceWith(previousCanvas);
  } else {
    canvas?.remove();
  }
  canvas = undefined;
  previousCanvas = null;
  vi.restoreAllMocks();
  restoreViewport();
});

function recordingContext() {
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.getElementById('gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  restoreViewport = setWindowViewport(800, 600);
  canvasManager.initialize();
  const ctx = canvasManager.requireContext();
  let points: Array<{ x: number; y: number }> = [];
  let arcs: Array<Parameters<CanvasRenderingContext2D['arc']>> = [];
  let closed = false;
  const dashes: number[][] = [];
  const strokes: Array<{
    points: typeof points;
    arcs: typeof arcs;
    closed: boolean;
    color: typeof ctx.strokeStyle;
    width: number;
  }> = [];
  const begin = ctx.beginPath.bind(ctx);
  const move = ctx.moveTo.bind(ctx);
  const line = ctx.lineTo.bind(ctx);
  const close = ctx.closePath.bind(ctx);
  const arc = ctx.arc.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  const dash = ctx.setLineDash.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    arcs = [];
    closed = false;
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
  vi.spyOn(ctx, 'arc').mockImplementation((...args) => {
    arcs.push(args);
    arc(...args);
  });
  vi.spyOn(ctx, 'setLineDash').mockImplementation((segments) => {
    dashes.push([...segments]);
    dash(segments);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    strokes.push({
      points: [...points],
      arcs: [...arcs],
      closed,
      color: ctx.strokeStyle,
      width: ctx.lineWidth,
    });
    Reflect.apply(stroke, ctx, args);
  });
  return { ctx, strokes, dashes };
}

function canvasColor(ctx: CanvasRenderingContext2D, color: string): string {
  ctx.save();
  ctx.strokeStyle = color;
  const normalized = ctx.strokeStyle;
  ctx.restore();
  return normalized;
}

function openVStrokes(
  strokes: Array<{ points: Array<{ x: number; y: number }>; closed: boolean; color: unknown }>,
  ctx: CanvasRenderingContext2D,
  color: string
) {
  const ink = canvasColor(ctx, color);
  return strokes.filter(
    (path) => path.points.length === 3 && path.closed === false && path.color === ink
  );
}

function flameReach(path: { points: Array<{ x: number; y: number }> }): number {
  const left = path.points[0];
  const tip = path.points[1];
  const right = path.points[2];
  if (!left || !tip || !right) {
    return 0;
  }
  const rearX = (left.x + right.x) / 2;
  const rearY = (left.y + right.y) / 2;
  return Math.hypot(tip.x - rearX, tip.y - rearY);
}

test('a discovered furnace roars a ship-style hearth flame inside the delivery zone', () => {
  const { ctx, strokes, dashes } = recordingContext();
  const fill = vi.spyOn(ctx, 'fill');
  drawFurnaceArtwork(ctx, 200, 220, 100, 0);

  expect(
    dashes.some((segments) => segments.length === 2 && segments[0] === 10 && segments[1] === 6)
  ).toBe(true);
  expect(
    strokes.some((path) =>
      path.arcs.some((arc) => arc[0] === 200 && arc[1] === 220 && arc[2] === 88)
    )
  ).toBe(true);

  const laserFlames = openVStrokes(strokes, ctx, hexToRgba(PALETTE.LASER_LOCAL, 1));
  const innerFlames = openVStrokes(strokes, ctx, hexToRgba(PALETTE.LASER_LOCAL, 0.95));
  const haloFlames = openVStrokes(strokes, ctx, hexToRgba(PALETTE.LOOT, 0.46));
  expect(laserFlames).toHaveLength(1);
  expect(innerFlames).toHaveLength(1);
  expect(haloFlames).toHaveLength(1);
  const main = laserFlames[0];
  if (!main) {
    throw new Error('Hearth flame did not draw a center plume');
  }
  const left = main.points[0];
  const tip = main.points[1];
  const right = main.points[2];
  if (!left || !tip || !right) {
    throw new Error('Hearth flame did not draw an open V');
  }
  const rearY = (left.y + right.y) / 2;
  expect(flameReach(main)).toBeGreaterThan(85);
  expect(Math.hypot(left.x - right.x, left.y - right.y) / 2).toBeGreaterThan(35);
  expect(tip.y).toBeLessThan(rearY);
  expect(tip.y).toBeLessThan(220);

  const coreInk = canvasColor(ctx, hexToRgba(PALETTE.LASER_LOCAL, 0.7));
  const cores = strokes.filter(
    (path) => path.points.length === 3 && path.closed === false && path.color === coreInk
  );
  const core = cores.reduce((longest, path) =>
    flameReach(path) > flameReach(longest) ? path : longest
  );
  expect(flameReach(core) / flameReach(main)).toBeCloseTo(VISUAL.THRUSTER_CORE_RATIO, 5);
  expect(fill.mock.calls.length).toBeGreaterThan(0);
  expect(laserFlames.every((path) => path.points.length === 3)).toBe(true);
});

test('the hearth plume flickers shorter on the same clock as ship thrust', () => {
  const { ctx, strokes } = recordingContext();
  drawFurnaceArtwork(ctx, 200, 220, 100, 0);
  const longFlames = openVStrokes(strokes, ctx, hexToRgba(PALETTE.LASER_LOCAL, 1));
  const longReach = Math.max(...longFlames.map((path) => flameReach(path)));
  strokes.length = 0;
  drawFurnaceArtwork(ctx, 200, 220, 100, VISUAL.THRUSTER_FLICKER_MS);
  const shortFlames = openVStrokes(strokes, ctx, hexToRgba(PALETTE.LASER_LOCAL, 1));
  const shortReach = Math.max(...shortFlames.map((path) => flameReach(path)));
  expect(shortReach).toBeLessThan(longReach);
  expect(shortReach / longReach).toBeGreaterThan(0.65);
  expect(shortReach / longReach).toBeLessThan(0.85);
});
