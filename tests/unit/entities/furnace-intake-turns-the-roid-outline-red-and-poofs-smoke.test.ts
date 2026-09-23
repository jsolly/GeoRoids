import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, VISUAL } from '../../../src/constants';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';
import {
  clearAsteroidShatters,
  drawAsteroidShatterBursts,
  markFurnaceAsteroidShatter,
  recordAsteroidShatter,
} from '../../../src/entities/roid/roidRenderer';
import { drawGame } from '../../../src/rendering/canvas';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { TestPath2D } from '../../support/TestPath2D';
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
  vi.unstubAllGlobals();
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
  let commands: Array<'move' | 'line'> = [];
  const strokes: Array<{
    points: Array<[number, number]>;
    arcs: Array<Parameters<CanvasRenderingContext2D['arc']>>;
    closed: boolean;
    commands: typeof commands;
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
    commands = [];
    arcs = [];
    closed = false;
    beginPath();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    commands.push('move');
    points.push([x, y]);
    moveTo(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    commands.push('line');
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
      commands: [...commands],
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

  drawAsteroidShatterBursts(pilot.ship);

  ctx.strokeStyle = PALETTE.DANGER;
  const danger = ctx.strokeStyle;
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  const smoke = ctx.strokeStyle;
  const edges = strokes.filter((path) => !path.closed && path.arcs.length === 0);
  const wisps = strokes.filter((path) => path.arcs.length === 1);
  expect(strokes.filter((path) => path.closed)).toEqual([]);
  expect(edges).toHaveLength(1);
  expect(wisps).toHaveLength(VISUAL.ROID_FURNACE_SMOKE_WISPS);
  expect(edges.map((path) => path.style)).toEqual([danger]);
  expect(edges[0]?.commands).toEqual(Array.from({ length: 4 }, () => ['move', 'line']).flat());
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

  drawAsteroidShatterBursts(pilot.ship);

  ctx.strokeStyle = PALETTE.ROID;
  const slate = ctx.strokeStyle;
  const firstBreak = strokes.filter((path) => !path.closed);
  expect(firstBreak).toHaveLength(2);
  expect(firstBreak.map((path) => path.commands)).toEqual([
    Array.from({ length: 4 }, () => ['move', 'line']).flat(),
    Array.from({ length: VISUAL.LASER_HIT_TICKS }, () => ['move', 'line']).flat(),
  ]);
  expect(firstBreak.every((path) => path.style === slate && path.arcs.length === 0)).toBe(true);

  markFurnaceAsteroidShatter(pending.id);
  strokes.length = 0;
  drawAsteroidShatterBursts(pilot.ship);

  ctx.strokeStyle = PALETTE.DANGER;
  const danger = ctx.strokeStyle;
  const edges = strokes.filter((path) => !path.closed && path.arcs.length === 0);
  const wisps = strokes.filter((path) => path.arcs.length === 1);
  expect(edges).toHaveLength(1);
  expect(edges.map((path) => path.style)).toEqual([danger]);
  expect(edges[0]?.commands).toEqual(Array.from({ length: 4 }, () => ['move', 'line']).flat());
  expect(wisps).toHaveLength(VISUAL.ROID_FURNACE_SMOKE_WISPS);
});

test('the playfield still paints a furnace poof after the last rock leaves the belt', () => {
  vi.stubGlobal('Path2D', TestPath2D);
  vi.spyOn(performance, 'now').mockReturnValue(2000);
  const { ctx, pilot } = asteroidScene();
  recordAsteroidShatter(consumedRock(), 2000, 'furnace');
  const strokes = recordStrokes(ctx);

  drawGame(pilot, new RoidBelt(), 0, 0, '', [pilot]);

  ctx.strokeStyle = PALETTE.DANGER;
  const danger = ctx.strokeStyle;
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  const smoke = ctx.strokeStyle;
  const edges = strokes.filter(
    (path) => !path.closed && path.arcs.length === 0 && path.style === danger
  );
  const wisps = strokes.filter((path) => path.arcs.length === 1 && path.style === smoke);
  expect(edges).toHaveLength(1);
  expect(wisps).toHaveLength(VISUAL.ROID_FURNACE_SMOKE_WISPS);
  expect(edges[0]?.points).toEqual([
    [494, 330],
    [480, 344],
    [480, 344],
    [466, 330],
    [466, 330],
    [480, 316],
    [480, 316],
    [494, 330],
  ]);
  expect(edges[0]?.commands).toEqual(Array.from({ length: 4 }, () => ['move', 'line']).flat());
  expect(wisps.every((path) => (path.arcs[0]?.[1] ?? 330) < 330)).toBe(true);
});
