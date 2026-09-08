import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, ROID, VISUAL } from '../../../src/constants';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  canDrawAsteroid,
  clearAsteroidShatters,
  drawRoidsRelative,
} from '../../../src/entities/roid/roidRenderer';
import { lockAsteroidPending } from '../../../src/physics/collision/asteroidHitFeel';
import { canvasManager } from '../../../src/rendering/canvas';
import * as vectorJuice from '../../../src/rendering/vectorJuice';

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
});

test('finite asteroid poses, including empty outlines, remain drawable while NaN poses are rejected', () => {
  const pose = { position: { x: 10, y: -4 }, r: 20, angle: 0.2, offsets: [1, 0.9, 1.1] };
  expect(canDrawAsteroid(pose)).toBe(true);
  expect(canDrawAsteroid({ ...pose, offsets: [] })).toBe(true);
  expect(canDrawAsteroid({ ...pose, position: { x: Number.NaN, y: 0 } })).toBe(false);
});

function asteroidScene() {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  clearAsteroidShatters();
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.getElementById('gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  canvasManager.initialize();
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvasManager.requireContext();
  const pilot = entityFactory.createPlayer({
    id: 'observer',
    name: 'Observer',
    type: 'remote',
    factionId: 'ion',
    position: { x: 20, y: 30 },
  });
  return { ctx, pilot };
}

function recordStrokes(ctx: CanvasRenderingContext2D) {
  let points: Array<[number, number]> = [];
  let closed = false;
  const strokes: Array<{
    points: Array<[number, number]>;
    closed: boolean;
    style: typeof ctx.strokeStyle;
    width: number;
    alpha: number;
    glow: number;
  }> = [];
  const beginPath = ctx.beginPath.bind(ctx);
  const moveTo = ctx.moveTo.bind(ctx);
  const lineTo = ctx.lineTo.bind(ctx);
  const closePath = ctx.closePath.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
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
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    strokes.push({
      points: [...points],
      closed,
      style: ctx.strokeStyle,
      width: ctx.lineWidth,
      alpha: ctx.globalAlpha,
      glow: ctx.shadowBlur,
    });
    Reflect.apply(stroke, ctx, args);
  });

  return strokes;
}

test('a pending asteroid shatters without its silhouette while a nearby empty-offset rock keeps its outline', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(2000);
  const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(2000);
  const { ctx, pilot } = asteroidScene();
  const outlines = vi.spyOn(vectorJuice, 'polygonPoints');
  const normal = new Roid({ x: -100, y: -60 }, 10, 'normal-empty-outline');
  normal.angle = 0;
  normal.vertices = 4;
  normal.offsets = [];
  const pending = new Roid({ x: 100, y: 60 }, 14, 'pending-shatter');
  pending.angle = 0;
  pending.vertices = 4;
  pending.offsets = [1, 1, 1, 1];
  lockAsteroidPending(pending, 2000);

  const strokes = recordStrokes(ctx);

  drawRoidsRelative(pilot.ship, [normal, pending]);

  const silhouettes = strokes.filter((path) => path.closed);
  expect(silhouettes).toHaveLength(2); // Glow and crisp passes of the identified normal rock.
  for (const path of silhouettes) {
    expect(path.points).toEqual([
      [290, 210],
      [280, 220],
      [270, 210],
      [280, 200],
    ]);
  }
  const shatter = strokes.filter((path) => !path.closed);
  expect(shatter).toHaveLength(8); // Four separated edges and four impact ticks at the pending rock.
  expect(shatter.slice(0, 4).map((path) => path.points)).toEqual([
    [
      [494, 330],
      [480, 344],
    ],
    [
      [480, 344],
      [466, 330],
    ],
    [
      [466, 330],
      [480, 316],
    ],
    [
      [480, 316],
      [494, 330],
    ],
  ]);
  for (const path of shatter) {
    expect(path.style).toBe('#94a3b8');
    expect(path.points).toHaveLength(2);
    for (const [x, y] of path.points) {
      expect(x).toBeGreaterThanOrEqual(466);
      expect(x).toBeLessThanOrEqual(494);
      expect(y).toBeGreaterThanOrEqual(316);
      expect(y).toBeLessThanOrEqual(344);
    }
  }

  // The shatter expires before the pending lock; no ghost silhouette should return.
  now.mockReturnValue(2300);
  performanceNow.mockReturnValue(2300);
  outlines.mockClear();
  strokes.length = 0;
  drawRoidsRelative(pilot.ship, [normal, pending]);
  expect(pending.pendingDestruction).toBe(true);
  expect(strokes).toEqual(silhouettes);
  expect(outlines.mock.calls.map(([x, y]) => [x, y])).toEqual([[280, 210]]);

  now.mockReturnValue(2800);
  performanceNow.mockReturnValue(2800);
  outlines.mockClear();
  strokes.length = 0;
  drawRoidsRelative(pilot.ship, [normal, pending]);

  expect(pending.pendingDestruction).toBe(false);
  expect(pending.pendingUntilMs).toBe(0);
  expect(outlines.mock.calls.map(([x, y]) => [x, y])).toEqual([
    [280, 210],
    [480, 330],
  ]);
  expect(strokes).toHaveLength(4);
  expect(strokes.slice(0, 2)).toEqual(silhouettes);
  for (const path of strokes.slice(2)) {
    expect(path.closed).toBe(true);
    expect(path.points).toEqual([
      [494, 330],
      [480, 344],
      [466, 330],
      [480, 316],
    ]);
  }
  expect(
    strokes.slice(2).map(({ style, width, alpha, glow }) => ({ style, width, alpha, glow }))
  ).toEqual(silhouettes.map(({ style, width, alpha, glow }) => ({ style, width, alpha, glow })));
});

test('large plain asteroids keep a jagged inner facet while medium, pebble and material rocks omit it', () => {
  const { ctx, pilot } = asteroidScene();
  const large = new Roid({ x: -220, y: -120 }, ROID.SIZE, 'large-plain');
  const medium = new Roid({ x: -60, y: -120 }, ROID.SIZE * 0.5, 'medium-plain');
  const pebble = new Roid({ x: 80, y: -120 }, ROID.SIZE * 0.2, 'pebble-plain');
  const material = new Roid({ x: 240, y: -120 }, ROID.SIZE, 'large-ice');
  material.material = 'ice';
  const offsets = [1.1, 0.8, 1.05, 0.9, 1.2, 0.85];
  for (const rock of [large, medium, pebble, material]) {
    rock.angle = 0;
    rock.vertices = offsets.length;
    rock.offsets = [...offsets];
  }
  const strokes = recordStrokes(ctx);
  const fill = vi.spyOn(ctx, 'fill');

  drawRoidsRelative(pilot.ship, [large, medium, pebble, material]);

  const outer = vectorJuice.polygonPoints(160, 150, ROID.SIZE, 0, offsets.length, offsets);
  const inner = vectorJuice.polygonPoints(
    160,
    150,
    ROID.SIZE,
    0,
    offsets.length,
    offsets,
    VISUAL.ROID_INNER_SCALE
  );
  const expectedContours = [
    outer,
    outer,
    inner,
    inner,
    ...[
      { rock: medium, x: 320 },
      { rock: pebble, x: 460 },
      { rock: material, x: 620 },
    ].flatMap(({ rock, x }) => {
      const outline = vectorJuice.polygonPoints(x, 150, rock.r, 0, offsets.length, offsets);
      return [outline, outline];
    }),
  ];
  const silhouettes = strokes.filter((path) => path.closed);
  expect(silhouettes.map((path) => path.points)).toEqual(
    expectedContours.map((points) => points.map(({ x, y }) => [x, y]))
  );
  const outerPath = silhouettes[0];
  const innerPath = silhouettes[2];
  if (!outerPath || !innerPath) {
    throw new Error('Large asteroid did not draw both outer and inner contours');
  }
  expect(outerPath.points).toHaveLength(6);
  expect(innerPath.points).toHaveLength(6);
  const outerFirst = outerPath.points[0];
  const innerFirst = innerPath.points[0];
  if (!outerFirst || !innerFirst) {
    throw new Error('Large asteroid contours did not contain their first vertex');
  }
  const outerReach = Math.hypot(outerFirst[0] - 160, outerFirst[1] - 150);
  const innerReach = Math.hypot(innerFirst[0] - 160, innerFirst[1] - 150);
  expect(outerReach).toBeCloseTo(ROID.SIZE * 1.1);
  expect(innerReach / outerReach).toBeCloseTo(VISUAL.ROID_INNER_SCALE);
  expect(VISUAL.ROID_INNER_SCALE).toBeGreaterThan(0.3);
  expect(VISUAL.ROID_INNER_SCALE).toBeLessThan(0.7);
  ctx.strokeStyle = PALETTE.ROID;
  const solid = ctx.strokeStyle;
  expect(
    silhouettes.filter((_, index) => [1, 5, 7, 9].includes(index)).map((path) => path.style)
  ).toEqual([solid, solid, solid, solid]);
  expect(silhouettes.slice(2, 4).map((path) => path.width)).toEqual([
    VISUAL.ROID_STROKE_SMALL,
    VISUAL.ROID_STROKE_SMALL,
  ]);
  const details = strokes.filter((path) => !path.closed);
  expect(details.map((path) => path.points)).toEqual([
    [
      [-0.72, 0.05],
      [-0.12, -0.22],
      [0.35, -0.7],
    ],
    [
      [-0.12, -0.22],
      [0.5, 0.43],
    ],
  ]);
  ctx.globalAlpha = 0.62;
  expect(details.map(({ style, alpha }) => ({ style, alpha }))).toEqual([
    { style: solid, alpha: ctx.globalAlpha },
    { style: solid, alpha: ctx.globalAlpha },
  ]);
  expect(fill).not.toHaveBeenCalled();
});
