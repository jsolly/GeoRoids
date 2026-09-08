import { afterEach, expect, test, vi } from 'vitest';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  canDrawAsteroid,
  clearAsteroidShatters,
  drawRoidsRelative,
} from '../../../src/entities/roid/roidRenderer';
import { lockAsteroidPending } from '../../../src/physics/collision/asteroidHitFeel';
import { canvasManager } from '../../../src/rendering/canvas';

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

test('a pending asteroid shatters without its silhouette while a nearby empty-offset rock keeps its outline', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const now = vi.spyOn(Date, 'now').mockReturnValue(2000);
  vi.spyOn(performance, 'now').mockReturnValue(2000);
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
  const normal = new Roid({ x: -100, y: -60 }, 10, 'normal-empty-outline');
  normal.angle = 0;
  normal.vertices = 4;
  normal.offsets = [];
  const pending = new Roid({ x: 100, y: 60 }, 14, 'pending-shatter');
  pending.angle = 0;
  pending.vertices = 4;
  pending.offsets = [1, 1, 1, 1];
  lockAsteroidPending(pending, 2000);

  let points: Array<[number, number]> = [];
  let closed = false;
  const strokes: Array<{
    points: Array<[number, number]>;
    closed: boolean;
    style: typeof ctx.strokeStyle;
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
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push({ points: [...points], closed, style: ctx.strokeStyle });
    stroke();
  });

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
  strokes.length = 0;
  drawRoidsRelative(pilot.ship, [normal, pending]);
  expect(pending.pendingDestruction).toBe(true);
  expect(strokes).toEqual(silhouettes);
});
