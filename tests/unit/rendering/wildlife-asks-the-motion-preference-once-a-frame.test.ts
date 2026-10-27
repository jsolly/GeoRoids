import { afterEach, expect, test, vi } from 'vitest';
import type { RolyPolyState } from '../../../shared-types';
import { setRolyPolys } from '../../../src/physics/terrain/rolyPolySession';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawRolyPoly, drawRolyPolys } from '../../../src/rendering/rolyPolyRenderer';
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
  setRolyPolys([]);
  restoreViewport();
  vi.restoreAllMocks();
});

function herd(count: number): RolyPolyState[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `roly-poly:${index}`,
    // Spread along the viewport centre line so every animal survives the cull.
    position: { x: index * 12, y: 0 },
    velocity: { x: 0.15, y: 0 },
    phase: index % 2 === 0 ? ('walking' as const) : ('rolling' as const),
  }));
}

test('a herd costs one motion-preference query a frame, not one per animal', () => {
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.querySelector('#gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  restoreViewport = setWindowViewport(1280, 900);
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));

  const animals = herd(24);
  setRolyPolys(animals);
  // `matchMedia` parses a media query against the CSSOM on every call, so the
  // count is the cost. Counting the production call itself keeps this honest:
  // no timing, no threshold.
  const queries = vi.spyOn(window, 'matchMedia');

  drawRolyPolys({ x: 0, y: 0 });

  const painted = queries.mock.calls.length;
  expect(painted).toBeLessThanOrEqual(1);

  // Prove the animals really were drawn, so the count above is not just an
  // empty loop: a cull that skipped everything would also report zero queries.
  const ctx = canvasManager.requireContext();
  const ellipses = vi.spyOn(ctx, 'ellipse');
  drawRolyPolys({ x: 0, y: 0 });
  expect(ellipses.mock.calls.length).toBeGreaterThanOrEqual(animals.length);
});

test('a direct caller still gets the preference read for it', () => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) {
    throw new Error('Canvas required');
  }
  const animal: RolyPolyState = {
    id: 'roly-poly:solo',
    position: { x: 8, y: 8 },
    velocity: { x: 0.15, y: 0 },
    phase: 'rolling',
  };

  const queries = vi.spyOn(window, 'matchMedia');
  drawRolyPoly(ctx, animal, animal.position, 16, 100);
  expect(queries).toHaveBeenCalledTimes(1);

  // Supplied explicitly, the frame's answer is used and nothing is re-queried.
  queries.mockClear();
  drawRolyPoly(ctx, animal, animal.position, 16, 100, true);
  expect(queries).not.toHaveBeenCalled();
});
