import { afterEach, describe, expect, test, vi } from 'vitest';

import { PALETTE, VISUAL } from '../../../src/constants';
import { HAULER_TETHER_COLOR } from '../../../src/entities/ship/shipKits';
import {
  contourLaserTick,
  contourLaserTickInto,
  contourLaserTicksForShots,
} from '../../../src/physics/terrain/contourLaser';
import { createHeightfield, sampleGradient } from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvas';
import {
  drawContourLaserTicks,
  liveLaserPositions,
} from '../../../src/rendering/contourLaserRenderer';

const BOUNDS = { cx: 0, cy: 0, radius: 3100 };

type TraceContext = CanvasRenderingContext2D & { moveToCount: number; strokeCount: number };

function traceContext(): TraceContext {
  let ctx = {} as TraceContext;
  ctx = {
    moveToCount: 0,
    strokeCount: 0,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => {
      ctx.moveToCount += 1;
    },
    lineTo: () => undefined,
    stroke: () => {
      ctx.strokeCount += 1;
    },
  } as unknown as TraceContext;
  return ctx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function steepPoint(seed: number): { x: number; y: number } {
  const field = createHeightfield(seed, BOUNDS);
  let best = { x: 1100, y: 0, steep: 0 };
  for (let a = 0; a < 24; a++) {
    const angle = (a / 24) * Math.PI * 2;
    for (const r of [700, 1100, 1500, 1900]) {
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      const g = sampleGradient(field, x, y);
      const steep = Math.hypot(g.x, g.y);
      if (steep > best.steep) {
        best = { x, y, steep };
      }
    }
  }
  return best;
}

describe('contour lasers stay a terrain blush, not a new authority path', () => {
  test('the same seed and shot pose produce the same iso-tangent', () => {
    const at = steepPoint(TERRAIN.DEFAULT_SEED);
    const a = contourLaserTick(createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS), at.x, at.y);
    const b = contourLaserTick(createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS), at.x, at.y);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  test('the tick is perpendicular to the height gradient and finite', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const at = steepPoint(TERRAIN.DEFAULT_SEED);
    const tick = contourLaserTick(field, at.x, at.y);
    expect(tick).not.toBeNull();
    if (!tick) {
      throw new Error('expected a contour tick on a steep face');
    }
    const g = sampleGradient(field, at.x, at.y);
    const dx = tick.bx - tick.ax;
    const dy = tick.by - tick.ay;
    expect(dx * g.x + dy * g.y).toBeCloseTo(0, 8);
    expect(Math.hypot(dx, dy)).toBeCloseTo(VISUAL.CONTOUR_LASER_LENGTH);
    expect(Object.values(tick).every(Number.isFinite)).toBe(true);
  });

  test('invalid poses and the flat spawn saddle do not light a tick', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    expect(contourLaserTick(field, 0, 0)).toBeNull();
    expect(contourLaserTick(field, Number.NaN, 5)).toBeNull();
    expect(contourLaserTick(field, 5, 5, 0)).toBeNull();
    expect(
      contourLaserTicksForShots(field, [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 1 },
      ])
    ).toEqual([]);
  });

  test('the reusable output object is filled only for a valid tangent', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const at = steepPoint(TERRAIN.DEFAULT_SEED);
    const out = { ax: 0, ay: 0, bx: 0, by: 0 };
    expect(contourLaserTickInto(out, field, at.x, at.y)).toBe(out);
    expect(Object.values(out).every(Number.isFinite)).toBe(true);
    expect(contourLaserTickInto(out, field, Number.POSITIVE_INFINITY, at.y)).toBeNull();
  });

  test('only currently rendered shots receive cream ticks', () => {
    const reusable: { x: number; y: number }[] = [];
    expect(
      liveLaserPositions([
        {
          lasers: [
            { position: { x: 10, y: 20 }, explodeTime: 0 },
            { position: { x: 30, y: 40 }, explodeTime: 3 },
            { position: { x: Number.NaN, y: 40 }, explodeTime: 0 },
            { position: { x: 50, y: 60 }, explodeTime: 0, hasExploded: true },
          ],
        },
        {
          visible: false,
          lasers: [{ position: { x: 50, y: 60 }, explodeTime: 0 }],
        },
        { lasers: [] },
      ])
    ).toEqual([{ x: 10, y: 20 }]);
    expect(
      liveLaserPositions([{ lasers: [{ position: { x: 70, y: 80 }, explodeTime: 0 }] }], reusable)
    ).toBe(reusable);
    expect(reusable).toEqual([{ x: 70, y: 80 }]);
  });

  test('offscreen contour shots are culled before terrain sampling', () => {
    const ctx = traceContext();
    const canvas = { width: 800, height: 600 } as HTMLCanvasElement;
    vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
    vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 800, height: 600 });
    vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out, world) => {
      out.x = Math.abs(world.x) > 5000 ? 10000 : 400;
      out.y = 300;
      return out;
    });
    ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);

    const visibleAt = steepPoint(TERRAIN.DEFAULT_SEED);
    drawContourLaserTicks({ x: 0, y: 0 }, [visibleAt]);
    const visibleMoves = ctx.moveToCount;
    expect(visibleMoves).toBeGreaterThan(0);

    drawContourLaserTicks({ x: 0, y: 0 }, [{ x: 10000, y: 10000 }]);
    expect(ctx.moveToCount).toBe(visibleMoves);
  });

  test('cream terrain response stays subordinate to a short bolt', () => {
    expect(PALETTE.LOOT).toBe('#E8D5A3');
    expect(PALETTE.LOOT).toBe(HAULER_TETHER_COLOR);
    expect(PALETTE.SHIELD).toBe('#7DD3C8');
    expect(VISUAL.CONTOUR_LASER_LENGTH).toBeLessThanOrEqual(2 * VISUAL.LASER_LENGTH);
    expect(VISUAL.CONTOUR_LASER_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.LASER_STROKE_WIDTH);
    expect(VISUAL.CONTOUR_LASER_ALPHA).toBeGreaterThan(VISUAL.CONTOUR_INDEX_ALPHA);
  });
});
