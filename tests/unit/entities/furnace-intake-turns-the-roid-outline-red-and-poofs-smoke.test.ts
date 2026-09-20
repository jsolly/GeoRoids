import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, VISUAL } from '../../../src/constants';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  clearAsteroidShatters,
  drawRoidsRelative,
  markFurnaceAsteroidShatter,
  recordAsteroidShatter,
} from '../../../src/entities/roid/roidRenderer';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};
let canvas: HTMLCanvasElement | undefined;
let previousCanvas: HTMLElement | null = null;

afterEach(() => {
  clearAsteroidShatters();
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

function asteroidScene() {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  clearAsteroidShatters();
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.querySelector('#gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  restoreViewport = setWindowViewport(800, 600);
  canvasManager.initialize();
  const ctx = canvasManager.requireContext();
  const pilot = entityFactory.createPlayer({
    id: 'observer',
    name: 'Observer',
    type: 'remote',
    position: { x: 20, y: 30 },
  });
  return { ctx, pilot };
}

function recordStrokes(ctx: CanvasRenderingContext2D) {
  let points: Array<[number, number]> = [];
  let arcs: Array<Parameters<CanvasRenderingContext2D['arc']>> = [];
  let closed = false;
  const strokes: Array<{
    points: Array<[number, number]>;
    arcs: Array<Parameters<CanvasRenderingContext2D['arc']>>;
    closed: boolean;
    style: typeof ctx.strokeStyle;
    width: number;
    alpha: number;
  }> = [];
  const beginPath = ctx.beginPath.bind(ctx);
  const moveTo = ctx.moveTo.bind(ctx);
  const lineTo = ctx.lineTo.bind(ctx);
  const closePath = ctx.closePath.bind(ctx);
  const arc = ctx.arc.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    arcs = [];
    closed = false;
    beginPath();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push([x, y]);
    moveTo(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    points.push([x, y]);
    lineTo(x, y);
  });
  vi.spyOn(ctx, 'closePath').mockImplementation(() => {
    closed = true;
    closePath();
  });
  vi.spyOn(ctx, 'arc').mockImplementation((...args) => {
    arcs.push(args);
    arc(...args);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    strokes.push({
      points: [...points],
      arcs: [...arcs],
      closed,
      style: ctx.strokeStyle,
      width: ctx.lineWidth,
      alpha: ctx.globalAlpha,
    });
    Reflect.apply(stroke, ctx, args);
  });
  return strokes;
}

function consumedRock() {
  const pending = new Roid({ x: 100, y: 60 }, 14, 'furnace-consumed');
  pending.angle = 0;
  pending.vertices = 4;
  pending.offsets = [1, 1, 1, 1];
  return pending;
}

test('furnace intake shatters the rock in danger-red with a short smoke poof instead of laser ticks', () => {
  vi.spyOn(performance, 'now').mockReturnValue(2000);
  const { ctx, pilot } = asteroidScene();
  const pending = consumedRock();
  recordAsteroidShatter(pending, 2000, 'furnace');
  const strokes = recordStrokes(ctx);
  const fill = vi.spyOn(ctx, 'fill');

  drawRoidsRelative(pilot.ship, []);

  ctx.strokeStyle = PALETTE.DANGER;
  const danger = ctx.strokeStyle;
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  const smoke = ctx.strokeStyle;
  const edges = strokes.filter((path) => !path.closed && path.arcs.length === 0);
  const wisps = strokes.filter((path) => path.arcs.length === 1);
  expect(strokes.filter((path) => path.closed)).toEqual([]);
  expect(edges).toHaveLength(4);
  expect(wisps).toHaveLength(VISUAL.ROID_FURNACE_SMOKE_WISPS);
  expect(edges.map((path) => path.style)).toEqual([danger, danger, danger, danger]);
  expect(wisps.map((path) => path.style)).toEqual(
    Array(VISUAL.ROID_FURNACE_SMOKE_WISPS).fill(smoke)
  );
  expect(wisps.every((path) => path.points.length === 0)).toBe(true);
  const originY = 330;
  expect(wisps.every((path) => (path.arcs[0]?.[1] ?? originY) < originY)).toBe(true);
  expect(fill).not.toHaveBeenCalled();
});

test('a furnace delivery retags an in-flight shatter so the outline goes red and smoke rises', () => {
  vi.spyOn(performance, 'now').mockReturnValue(2000);
  const { ctx, pilot } = asteroidScene();
  const pending = consumedRock();
  recordAsteroidShatter(pending, 2000);
  const strokes = recordStrokes(ctx);

  drawRoidsRelative(pilot.ship, []);

  ctx.strokeStyle = PALETTE.ROID;
  const slate = ctx.strokeStyle;
  const firstBreak = strokes.filter((path) => !path.closed);
  expect(firstBreak).toHaveLength(8);
  expect(firstBreak.every((path) => path.style === slate && path.arcs.length === 0)).toBe(true);

  markFurnaceAsteroidShatter(pending.id);
  strokes.length = 0;
  drawRoidsRelative(pilot.ship, []);

  ctx.strokeStyle = PALETTE.DANGER;
  const danger = ctx.strokeStyle;
  const edges = strokes.filter((path) => !path.closed && path.arcs.length === 0);
  const wisps = strokes.filter((path) => path.arcs.length === 1);
  expect(edges).toHaveLength(4);
  expect(edges.map((path) => path.style)).toEqual([danger, danger, danger, danger]);
  expect(wisps).toHaveLength(VISUAL.ROID_FURNACE_SMOKE_WISPS);
});
