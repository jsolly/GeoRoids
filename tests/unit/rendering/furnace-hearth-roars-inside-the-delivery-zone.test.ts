import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE } from '../../../src/constants';
import { canvasManager } from '../../../src/rendering/canvas';
import { drawFurnaceArtwork } from '../../../src/rendering/furnaceRenderer';
import { hexToRgba } from '../../../src/utils/colorUtils';
import { setWindowViewport } from '../../support/viewport';

interface RecordedPath {
  points: Array<{ x: number; y: number }>;
  arcs: Array<Parameters<CanvasRenderingContext2D['arc']>>;
  closed: boolean;
  color: string;
  width: number;
}

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
  const strokes: RecordedPath[] = [];
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
      color: String(ctx.strokeStyle),
      width: ctx.lineWidth,
    });
    Reflect.apply(stroke, ctx, args);
  });
  return { ctx, strokes, dashes };
}

function canvasColor(ctx: CanvasRenderingContext2D, color: string): string {
  ctx.save();
  ctx.strokeStyle = color;
  const normalized = String(ctx.strokeStyle);
  ctx.restore();
  return normalized;
}

/** Each tongue is a closed teardrop: left edge root→tip, then right edge tip→root. */
function flameContours(strokes: RecordedPath[]): RecordedPath[] {
  return strokes.filter((path) => path.closed && path.points.length >= 21);
}

function apexOf(path: RecordedPath): { x: number; y: number } {
  return path.points.reduce((highest, point) => (point.y < highest.y ? point : highest));
}

function rootOf(path: RecordedPath): { x: number; y: number } {
  return path.points.reduce((lowest, point) => (point.y > lowest.y ? point : lowest));
}

/** Horizontal span between the two edges at the same height along the tongue. */
function spanAt(path: RecordedPath, step: number): number {
  const left = path.points[step];
  const right = path.points[path.points.length - 1 - step];
  if (!left || !right) {
    throw new Error('flame contour is missing an edge sample');
  }
  return right.x - left.x;
}

function centerAt(path: RecordedPath, step: number): number {
  const left = path.points[step];
  const right = path.points[path.points.length - 1 - step];
  if (!left || !right) {
    throw new Error('flame contour is missing an edge sample');
  }
  return (left.x + right.x) / 2;
}

test('a discovered furnace burns a towering fire that fills the delivery zone', () => {
  const { ctx, strokes, dashes } = recordingContext();
  const fill = vi.spyOn(ctx, 'fill');
  drawFurnaceArtwork(ctx, 300, 300, 100, 0);

  expect(
    dashes.some((segments) => segments.length === 2 && segments[0] === 10 && segments[1] === 6)
  ).toBe(true);
  expect(
    strokes.some((path) =>
      path.arcs.some((arc) => arc[0] === 300 && arc[1] === 300 && arc[2] === 88)
    )
  ).toBe(true);
  expect(fill.mock.calls.length).toBeGreaterThan(0);

  const contours = flameContours(strokes);
  expect(contours.length).toBeGreaterThanOrEqual(9);

  const yellow = canvasColor(ctx, hexToRgba(PALETTE.LASER_LOCAL, 1));
  const cream = canvasColor(ctx, hexToRgba(PALETTE.LOOT, 0.34));
  expect(contours.some((path) => path.color === yellow)).toBe(true);
  expect(contours.some((path) => path.color === cream)).toBe(true);

  const tallest = contours.reduce((best, path) => (apexOf(path).y < apexOf(best).y ? path : best));
  const root = rootOf(tallest);
  // Rises from a fire bed below center, up through the intake radius.
  expect(root.y).toBeGreaterThan(300);
  expect(300 - apexOf(tallest).y).toBeGreaterThan(50);

  // The fire spreads across the hearth, and every tongue narrows at root and tip.
  expect(Math.max(...contours.map((path) => spanAt(path, 4)))).toBeGreaterThan(90);
  const belly = spanAt(tallest, 4);
  expect(spanAt(tallest, 0)).toBeLessThan(belly);
  expect(spanAt(tallest, 16)).toBeLessThan(belly / 3);

  // Real fire is not a mirrored chevron: the two edges ripple independently.
  const mirrored = Array.from({ length: 17 }, (_, step) =>
    Math.abs(centerAt(tallest, step) - centerAt(tallest, 0))
  );
  expect(Math.max(...mirrored)).toBeGreaterThan(0.5);
});

test('the fire surges up the intake without escaping the delivery zone', () => {
  const { ctx, strokes } = recordingContext();
  const peaks: number[] = [];
  for (let frame = 0; frame < 24; frame += 1) {
    strokes.length = 0;
    drawFurnaceArtwork(ctx, 300, 300, 100, frame * 50);
    const contours = flameContours(strokes);
    peaks.push(Math.max(...contours.map((path) => 300 - apexOf(path).y)));
  }
  // A surge climbs most of the 100-unit intake radius; nothing spills past the ring.
  expect(Math.max(...peaks)).toBeGreaterThan(85);
  expect(Math.max(...peaks)).toBeLessThan(110);
  // It guts back down between surges rather than standing at one height.
  expect(Math.min(...peaks)).toBeLessThan(Math.max(...peaks) - 15);
});

test('the furnace fire licks and breathes from frame to frame', () => {
  const { ctx, strokes } = recordingContext();
  drawFurnaceArtwork(ctx, 300, 300, 100, 0);
  const first = flameContours(strokes).map((path) => ({
    apex: apexOf(path).y,
    tipX: centerAt(path, 17),
  }));
  strokes.length = 0;
  drawFurnaceArtwork(ctx, 300, 300, 100, 420);
  const second = flameContours(strokes).map((path) => ({
    apex: apexOf(path).y,
    tipX: centerAt(path, 17),
  }));

  expect(second).toHaveLength(first.length);
  const heightChange = first.map((path, index) =>
    Math.abs(path.apex - (second[index]?.apex ?? path.apex))
  );
  const tipTravel = first.map((path, index) =>
    Math.abs(path.tipX - (second[index]?.tipX ?? path.tipX))
  );
  expect(Math.max(...heightChange)).toBeGreaterThan(4);
  expect(Math.max(...tipTravel)).toBeGreaterThan(4);
  // The fire breathes rather than teleporting: it stays inside the intake.
  for (const { apex } of second) {
    expect(300 - apex).toBeLessThan(110);
  }
});
