import { afterEach, expect, test, vi } from 'vitest';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { scanCameraZoom } from '../../../src/rendering/canvas';
import { canvasManager } from '../../../src/rendering/canvasSurface';

let canvas: HTMLCanvasElement | undefined;
afterEach(() => {
  canvasManager.destroy();
  canvas?.remove();
  vi.restoreAllMocks();
});

const scout = {
  kitId: 'scout' as const,
  position: { x: 0, y: 0 },
  abilityActiveFrames: 0,
  health: 100,
  exploding: false,
};

function mountCanvas(): CanvasRenderingContext2D {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  document.body.append(canvas);
  canvasManager.initialize();
  return canvasManager.requireContext();
}

/** Run the renderer's per-frame easing for `ms` at 60 Hz toward the scan-driven target. */
function flyFor(ms: number, fromMs: number, activeFrames: number): number {
  let now = fromMs;
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    now += 16;
    const target = scanCameraZoom({ ...scout, abilityActiveFrames: activeFrames }, 800, 600);
    canvasManager.easeZoomToward(target, now);
  }
  return now;
}

function worldViewport(context: CanvasRenderingContext2D) {
  canvasManager.beginWorldLayers(context);
  const size = { ...canvasManager.getViewportSize() };
  canvasManager.endWorldLayers(context);
  return size;
}

test('a Scout scan widens the world view to fit the whole scan range', () => {
  const context = mountCanvas();
  flyFor(100, 0, SHIP_ABILITY.SCAN_FRAMES);
  const easing = worldViewport(context);
  expect(easing.height).toBeGreaterThan(600);

  flyFor(1000, 100, SHIP_ABILITY.SCAN_FRAMES);
  const wide = worldViewport(context);
  expect(wide.height).toBeGreaterThan(easing.height);
  expect(Math.min(wide.width, wide.height) / 2).toBeGreaterThanOrEqual(SHIP_ABILITY.SCAN_RANGE);
  // The HUD keeps drawing against the real screen.
  expect(canvasManager.getViewportSize()).toEqual({ width: 800, height: 600 });
});

test('the widened view maps its far corner onto the real screen corner', () => {
  const context = mountCanvas();
  flyFor(1500, 0, SHIP_ABILITY.SCAN_FRAMES);
  const dpr = context.getTransform().a;
  canvasManager.beginWorldLayers(context);
  const { width, height } = canvasManager.getViewportSize();
  const world = context.getTransform();
  expect(world.a * width + world.e).toBeCloseTo(800 * dpr, 3);
  expect(world.d * height + world.f).toBeCloseTo(600 * dpr, 3);
  canvasManager.endWorldLayers(context);
});

test('when the pulse ends the camera returns to exact flight scale', () => {
  const context = mountCanvas();
  const scanned = flyFor(1500, 0, SHIP_ABILITY.SCAN_FRAMES);
  flyFor(2000, scanned, 0);
  const before = context.getTransform();
  canvasManager.beginWorldLayers(context);
  expect(canvasManager.getViewportSize()).toEqual({ width: 800, height: 600 });
  expect(context.getTransform()).toEqual(before);
  canvasManager.endWorldLayers(context);
});

test('ships without an active scan keep the flight view', () => {
  expect(scanCameraZoom(scout, 800, 600)).toBe(1);
  expect(scanCameraZoom({ ...scout, kitId: 'hauler', abilityActiveFrames: 60 }, 800, 600)).toBe(1);
});
