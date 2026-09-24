import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, ROID, VISUAL } from '../../../src/constants';
import { entityFactory } from '../../../src/entities/EntityFactory';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  canDrawAsteroid,
  clearAsteroidShatters,
  drawAsteroidShatterBursts,
  drawRoidsRelative,
  recordAsteroidShatter,
} from '../../../src/entities/roid/roidRenderer';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import * as vectorJuice from '../../../src/rendering/vectorJuice';
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
  let closed = false;
  let commands: Array<'move' | 'line'> = [];
  const strokes: Array<{
    points: Array<[number, number]>;
    closed: boolean;
    commands: typeof commands;
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
    commands = [];
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
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    strokes.push({
      points: [...points],
      closed,
      commands: [...commands],
      style: ctx.strokeStyle,
      width: ctx.lineWidth,
      alpha: ctx.globalAlpha,
      glow: ctx.shadowBlur,
    });
    Reflect.apply(stroke, ctx, args);
  });

  return strokes;
}

test('a destroyed asteroid shatters without its silhouette while a nearby empty-offset rock keeps its outline', () => {
  const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(2000);
  const { ctx, pilot } = asteroidScene();
  const outlines = vi.spyOn(vectorJuice, 'polygonPoints');
  const normal = new Roid({ x: -100, y: -60 }, 10, 'normal-empty-outline');
  normal.angle = 0;
  normal.vertices = 4;
  normal.offsets = [];
  const pending = new Roid({ x: 100, y: 60 }, 14, 'destroyed-shatter');
  pending.angle = 0;
  pending.vertices = 4;
  pending.offsets = [1, 1, 1, 1];
  recordAsteroidShatter(pending, 2000);

  const strokes = recordStrokes(ctx);
  const images = vi.spyOn(ctx, 'drawImage');
  const placement = vi.spyOn(ctx, 'translate');

  drawRoidsRelative(pilot.ship, [normal]);
  drawAsteroidShatterBursts(pilot.ship);

  expect(images).toHaveBeenCalledTimes(1);
  const sprite = images.mock.calls[0]?.[0];
  if (!(sprite instanceof HTMLCanvasElement)) {
    throw new Error('Normal asteroid did not draw its cached silhouette');
  }
  expect(placement).toHaveBeenCalledWith(280, 210);
  const origin = sprite.width / 2;
  expect(outlines.mock.calls[0]).toEqual([origin, origin, 10, 0, 4, [1], 1]);
  expect(strokes.filter((path) => path.closed)).toEqual([]);
  const shatter = strokes.filter((path) => !path.closed);
  expect(shatter).toHaveLength(2);
  expect(shatter[0]?.points).toEqual([
    [494, 330],
    [480, 344],
    [480, 344],
    [466, 330],
    [466, 330],
    [480, 316],
    [480, 316],
    [494, 330],
  ]);
  expect(shatter[1]?.points).toEqual(
    Array.from({ length: VISUAL.LASER_HIT_TICKS }, (_, index) => {
      const tick = vectorJuice.burstTick(480, 330, (index * Math.PI) / 2, 14 * 0.25, 14 * 0.55);
      return [
        [tick.x1, tick.y1],
        [tick.x2, tick.y2],
      ];
    }).flat()
  );
  expect(shatter.map((path) => path.width)).toEqual([VISUAL.ROID_STROKE_SMALL, 1]);
  ctx.shadowBlur = VISUAL.ROID_GLOW;
  const canvasGlow = ctx.shadowBlur;
  for (const path of shatter) {
    expect(path.style).toBe('#94a3b8');
    expect(path.alpha).toBe(1);
    expect(path.glow).toBe(canvasGlow);
    expect(path.commands).toEqual(Array.from({ length: 4 }, () => ['move', 'line']).flat());
    for (const [x, y] of path.points) {
      expect(x).toBeGreaterThanOrEqual(466);
      expect(x).toBeLessThanOrEqual(494);
      expect(y).toBeGreaterThanOrEqual(316);
      expect(y).toBeLessThanOrEqual(344);
    }
  }

  // Authoritative destruction leaves a brief break effect, never a returning silhouette.
  performanceNow.mockReturnValue(2300);
  outlines.mockClear();
  strokes.length = 0;
  drawRoidsRelative(pilot.ship, [normal]);
  drawAsteroidShatterBursts(pilot.ship);
  expect(strokes).toEqual([]);
  expect(outlines).not.toHaveBeenCalled();
  expect(images.mock.calls[1]?.[0]).toBe(sprite);
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
  const images = vi.spyOn(ctx, 'drawImage');
  const phosphor = vi.spyOn(vectorJuice, 'strokePhosphorPolyline');

  drawRoidsRelative(pilot.ship, [large, medium, pebble, material]);

  expect(images).toHaveBeenCalledTimes(4);
  const expectedContours = [large, medium, pebble, material].flatMap((rock, index) => {
    const image = images.mock.calls[index]?.[0];
    if (!(image instanceof HTMLCanvasElement)) {
      throw new Error('Asteroid did not draw a cached silhouette');
    }
    const origin = image.width / 2;
    const outer = vectorJuice.polygonPoints(origin, origin, rock.r, 0, offsets.length, offsets);
    const contours = [outer];
    if (rock === large) {
      contours.push(
        vectorJuice.polygonPoints(
          origin,
          origin,
          rock.r,
          0,
          offsets.length,
          offsets,
          VISUAL.ROID_INNER_SCALE
        )
      );
    }
    return contours;
  });
  expect(phosphor.mock.calls.map((call) => call[1])).toEqual(expectedContours);
  const largeSprite = images.mock.calls[0]?.[0];
  const outer = phosphor.mock.calls[0]?.[1];
  const inner = phosphor.mock.calls[1]?.[1];
  const outerFirst = outer?.[0];
  const innerFirst = inner?.[0];
  if (!(largeSprite instanceof HTMLCanvasElement) || !outerFirst || !innerFirst) {
    throw new Error('Large asteroid did not paint both cached contours');
  }
  expect(outer).toHaveLength(6);
  expect(inner).toHaveLength(6);
  const origin = largeSprite.width / 2;
  const outerReach = Math.hypot(outerFirst.x - origin, outerFirst.y - origin);
  const innerReach = Math.hypot(innerFirst.x - origin, innerFirst.y - origin);
  expect(outerReach).toBeCloseTo(ROID.SIZE * 1.1);
  expect(innerReach / outerReach).toBeCloseTo(VISUAL.ROID_INNER_SCALE);
  expect(innerReach).toBeGreaterThan(outerReach * 0.3);
  expect(innerReach).toBeLessThan(outerReach * 0.7);
  expect(
    phosphor.mock.calls.map((call) => [call[2], call[3], call[4], call[5], call[6] ?? 1])
  ).toEqual([
    [PALETTE.ROID, VISUAL.ROID_STROKE_LARGE, VISUAL.ROID_GLOW, true, 1],
    [PALETTE.ROID, VISUAL.ROID_STROKE_SMALL, VISUAL.ROID_GLOW * 0.45, true, 0.62],
    [PALETTE.ROID, VISUAL.ROID_STROKE_MEDIUM, VISUAL.ROID_GLOW, true, 1],
    [PALETTE.ROID, VISUAL.ROID_STROKE_SMALL, VISUAL.ROID_GLOW, true, 1],
    [PALETTE.ROID, VISUAL.ROID_STROKE_LARGE, VISUAL.ROID_GLOW, true, 1],
  ]);
  expect(strokes.filter((path) => path.closed)).toEqual([]);
  ctx.strokeStyle = PALETTE.ROID;
  const solid = ctx.strokeStyle;
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

test('rubble shatter keeps its drifting wobble and fading ticks halfway through its lifetime', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(2000 + VISUAL.ROID_SHATTER_MS / 2);
  const { ctx, pilot } = asteroidScene();
  const rock = new Roid({ x: 100, y: 60 }, 14, 'rubble-shatter');
  rock.angle = 0;
  rock.vertices = 4;
  rock.offsets = [1, 1, 1, 1];
  rock.material = 'rubble';
  recordAsteroidShatter(rock, 2000);
  const strokes = recordStrokes(ctx);
  drawAsteroidShatterBursts(pilot.ship);
  const points = vectorJuice.polygonPoints(480, 330, 14, 0, 4, rock.offsets);
  const expected = points.flatMap((a, index) => {
    const b = points[(index + 1) % points.length];
    if (!b) {
      throw new Error('Missing shatter endpoint');
    }
    const edge = vectorJuice.driftSegment(
      a,
      b,
      { x: 480, y: 330 },
      0.5,
      14 * VISUAL.ROID_SHATTER_SPREAD
    );
    const wobble = Math.sin(index * 2.4 + 4) * 14 * 0.5 * 0.3;
    return [
      [edge.a.x + wobble, edge.a.y - wobble],
      [edge.b.x - wobble, edge.b.y + wobble],
    ];
  });
  expect(strokes[0]?.points).toEqual(expected);
  expect(strokes[0]?.commands).toEqual(Array.from({ length: 4 }, () => ['move', 'line']).flat());
  expect(strokes[0]?.alpha).toBeCloseTo(1 - 0.5 * 0.85, 2);
  ctx.shadowBlur = VISUAL.ROID_GLOW;
  expect(strokes[0]?.glow).toBe(ctx.shadowBlur);
  expect(strokes[1]?.points).toEqual(
    Array.from({ length: VISUAL.LASER_HIT_TICKS }, (_, index) => {
      const tick = vectorJuice.burstTick(
        480,
        330,
        0.2 + (index * Math.PI) / 2,
        14 * (0.25 + 0.5 * 0.35),
        14 * (0.55 + 0.5 * 0.85)
      );
      return [
        [tick.x1, tick.y1],
        [tick.x2, tick.y2],
      ];
    }).flat()
  );
  clock.mockReturnValue(2000 + VISUAL.ROID_SHATTER_MS);
  strokes.length = 0;
  drawAsteroidShatterBursts(pilot.ship);
  expect(strokes).toEqual([]);
});
