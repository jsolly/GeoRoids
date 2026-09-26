import { afterEach, describe, expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { WORLD } from '../../../shared/world';
import { PALETTE, VISUAL } from '../../../src/constants';
import { contourSegmentCount, extractIsoContours } from '../../../src/physics/terrain/contours';
import {
  createHeightfield,
  sampleGradient,
  sampleHeight,
} from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import {
  applyTerrainSeed,
  builtContourPatchCount,
  CONTOUR_REGION_STEP,
  ensureTerrain,
  getTerrainContours,
  getTerrainSeed,
  peekBuiltContourPatch,
} from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawIsoContours } from '../../../src/rendering/contourRenderer';
import { contourSpatialIndexIsCached } from '../../../src/rendering/contourSpatialIndex';
import { TestPath2D } from '../../support/TestPath2D';

const BOUNDS = { cx: 0, cy: 0, radius: 3100 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
});

describe('seeded heightfield is shared', () => {
  test('the same seed produces the same heights and contour set', () => {
    const a = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const b = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const samples = [
      { x: 0, y: 0 },
      { x: 400, y: -200 },
      { x: -1200, y: 800 },
      { x: 2000, y: 1400 },
    ];
    for (const p of samples) {
      expect(sampleHeight(a, p.x, p.y)).toBe(sampleHeight(b, p.x, p.y));
    }
    expect(extractIsoContours(a)).toEqual(extractIsoContours(b));
  });

  test('room seeds produce distinct hills and valleys', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const other = createHeightfield(TERRAIN.DEFAULT_SEED + 99, BOUNDS);
    expect(sampleHeight(field, -1300, -700)).not.toBe(sampleHeight(other, -1300, -700));
    expect(sampleHeight(field, -1300, -700)).toBeGreaterThan(0);
    expect(sampleHeight(field, -1400, 2400)).toBeLessThan(0);
    expect(sampleHeight(field, -1300, -700)).not.toBe(sampleHeight(field, 0, 1550));
  });

  test('gameState carries the room seed so late joiners match', () => {
    const engine = new GameEngine(1);
    const state = engine.getGameState();
    expect(state.terrainSeed).toBe(1);
    expect(engine.getTerrainSeed()).toBe(getTerrainSeed());
    applyTerrainSeed(state.terrainSeed);
    expect(getTerrainSeed()).toBe(1);
    engine.stopGameLoop();
  });
});

describe('iso contours encode elevation', () => {
  test('cuts retain the original contour density across plains and hills', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, { radius: 60000 });
    // Counts measured from the original terrain at these same views.
    for (const [cx, cy, originalCount] of [
      [0, 0, 10799],
      [4200, 0, 10550],
      [-2100, 700, 10170],
    ] satisfies [number, number, number][]) {
      const levels = extractIsoContours(field, 96, 18, { cx: cx ?? 0, cy: cy ?? 0, radius: 2048 });
      expect(contourSegmentCount(levels)).toBeGreaterThan(originalCount * 0.9);
    }
  });

  test('contours stay inside the circular arena', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    for (const level of extractIsoContours(field)) {
      for (const seg of level.segments) {
        const mx = (seg.ax + seg.bx) * 0.5;
        const my = (seg.ay + seg.by) * 0.5;
        expect(Math.hypot(mx, my)).toBeLessThanOrEqual(BOUNDS.radius + 1);
      }
    }
  });
});

describe('muted contour chrome', () => {
  test('contour strokes stay darker and thinner than ships and lasers', () => {
    expect(PALETTE.CONTOUR.toLowerCase()).not.toBe('#ffffff');
    expect(PALETTE.CONTOUR.toLowerCase()).not.toBe(PALETTE.LOCAL.toLowerCase());
    expect(PALETTE.CONTOUR.toLowerCase()).not.toBe(PALETTE.LASER_LOCAL.toLowerCase());
    expect(VISUAL.CONTOUR_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.SHIP_STROKE_WIDTH);
    expect(VISUAL.CONTOUR_ALPHA).toBeLessThanOrEqual(0.3);
    expect(VISUAL.CONTOUR_INDEX_ALPHA).toBeLessThanOrEqual(0.5);
    expect(VISUAL.CONTOUR_INDEX_ALPHA).toBeGreaterThan(VISUAL.CONTOUR_ALPHA);
  });

  test('contours render neutral strokes without elevation numbers', () => {
    vi.stubGlobal('Path2D', TestPath2D);
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Missing real terrain canvas');
    }
    vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
    vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 800, height: 600 });
    vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
    ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
    const strokes: Array<string | CanvasGradient | CanvasPattern> = [];
    vi.spyOn(ctx, 'stroke').mockImplementation(() => {
      strokes.push(ctx.strokeStyle);
    });
    const labels = vi.spyOn(ctx, 'fillText');
    drawIsoContours({ x: 0, y: 0 });
    expect(strokes.length).toBeGreaterThan(0);
    for (const color of strokes) {
      expect(String(color)).toMatch(/^rgba\(104, 104, 104, /u);
    }
    expect(labels).not.toHaveBeenCalled();
  });
});

test('ensureTerrain caches the active room field', () => {
  const first = ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
  const second = ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
  expect(second).toBe(first);
});

test('translated arenas retain the same terrain and a stable flat spawn', () => {
  const base = createHeightfield(7, BOUNDS);
  const field = createHeightfield(7, { cx: 250, cy: -170, radius: 3100 });
  for (const { x, y } of [
    { x: 0, y: 0 },
    { x: 500, y: 500 },
    { x: 1550, y: 0 },
    { x: -600, y: 800 },
  ]) {
    expect(sampleHeight(field, field.cx + x, field.cy + y)).toBeCloseTo(
      sampleHeight(base, x, y),
      10
    );
  }
  expect(sampleHeight(field, field.cx + field.radius + 10, field.cy)).toBe(0);
  expect(sampleGradient(field, field.cx + field.radius, field.cy)).toEqual({ x: 0, y: 0 });
  const inside = sampleGradient(field, field.cx + field.radius - 1, field.cy);
  expect(Math.hypot(inside.x, inside.y)).toBeLessThan(1e-5);
});

test('crossing into the next contour patch reuses a warmed neighbor instead of remarching', async () => {
  vi.useFakeTimers();
  ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius });
  const origin = getTerrainContours({ x: 0, y: 0 }, 800);
  expect(builtContourPatchCount()).toBe(1);
  expect(contourSpatialIndexIsCached(origin)).toBe(true);

  const nextCenter = { x: CONTOUR_REGION_STEP, y: 0 };
  let neighbor = peekBuiltContourPatch(nextCenter, 800);
  for (let step = 0; step < 4 && !neighbor; step++) {
    await vi.advanceTimersByTimeAsync(0);
    neighbor = peekBuiltContourPatch(nextCenter, 800);
  }
  expect(neighbor).toBeDefined();
  if (!neighbor) {
    return;
  }
  expect(neighbor).not.toBe(origin);
  expect(contourSpatialIndexIsCached(neighbor)).toBe(true);
  const warmed = builtContourPatchCount();
  expect(warmed).toBeGreaterThan(1);

  const levels = getTerrainContours(nextCenter, 800);
  expect(levels).toBe(neighbor);
  expect(builtContourPatchCount()).toBe(warmed);
  expect(contourSegmentCount(levels)).toBeGreaterThan(100);
  expect(
    levels.some((level) => level.segments.some((segment) => segment.ax > 2048 || segment.bx > 2048))
  ).toBe(true);
});
