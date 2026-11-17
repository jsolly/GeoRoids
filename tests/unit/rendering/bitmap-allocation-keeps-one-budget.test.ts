import { afterEach, expect, test, vi } from 'vitest';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { clearLootArtwork, drawLootRelative } from '../../../src/entities/loot/lootRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { drawLaserBolts } from '../../../src/entities/ship/shipRenderer';
import {
  BITMAP_BUDGET_BYTES,
  readBitmapBudget,
  releaseBitmap,
  resizeBitmap,
} from '../../../src/rendering/bitmapBudget';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { discardRasterSurface, prepareRasterSurface } from '../../../src/rendering/rasterSurface';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import { paintMapLegend } from '../../../src/ui/universeMap';

const canvases: HTMLCanvasElement[] = [];
const canvas = () => {
  const result = document.createElement('canvas');
  canvases.push(result);
  return result;
};
afterEach(() => {
  for (const item of canvases.splice(0)) {
    releaseBitmap(item);
  }
  vi.restoreAllMocks();
  configureRenderQuality('', 'desktop');
});

test('resizing credits the old bitmap and diagnostics report actual live, peak and mandatory excess', () => {
  const before = readBitmapBudget();
  const target = canvas();
  resizeBitmap(target, 100, 200, 'budget-test');
  expect(readBitmapBudget().liveBytes).toBe(before.liveBytes + 80_000);
  resizeBitmap(target, 50, 20, 'budget-test');
  expect(readBitmapBudget().liveBytes).toBe(before.liveBytes + 4000);
  expect(clientPerformance.read().bitmapBudget.owners['budget-test']).toBe(4000);
  resizeBitmap(target, 4097, 4096, 'budget-test');
  const live = readBitmapBudget();
  expect(live.liveBytes).toBe(before.liveBytes + 4097 * 4096 * 4);
  expect(live.overBudgetBytes).toBe(live.liveBytes - BITMAP_BUDGET_BYTES);
  expect(live.highWaterBytes).toBeGreaterThanOrEqual(live.liveBytes);
  releaseBitmap(target);
  releaseBitmap(target);
  expect(readBitmapBudget().liveBytes).toBe(before.liveBytes);
});

test('recycled artwork earns resize credit and discarded or failed contexts leave no charge', () => {
  const before = readBitmapBudget().liveBytes;
  const surface = prepareRasterSurface(30, 20, undefined, 'recycled-test');
  expect(surface).toBeDefined();
  if (!surface) {
    throw new Error('Expected artwork');
  }
  expect(prepareRasterSurface(10, 10, surface, 'recycled-test')).toBe(surface);
  expect(readBitmapBudget().liveBytes).toBe(before + 400);
  discardRasterSurface(surface);
  expect(readBitmapBudget().liveBytes).toBe(before);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  expect(() => prepareRasterSurface(10, 10, undefined, 'broken context')).toThrow('broken context');
  expect(readBitmapBudget().liveBytes).toBe(before);
});

test('an exhausted shared budget denies caches while a laser still paints its native artwork', () => {
  const reserve = canvas();
  resizeBitmap(reserve, 4096, 4096, 'presentation-test');
  const denied = readBitmapBudget().deniedAllocations;
  expect(prepareRasterSurface(100, 100, undefined, 'denied-test')).toBeUndefined();
  const target = canvas();
  target.width = 200;
  target.height = 100;
  const context = target.getContext('2d');
  if (!context) {
    throw new Error('Expected painter');
  }
  configureRenderQuality('?renderGlow=off', 'desktop');
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(context);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 200, height: 100 });
  vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out, position) =>
    Object.assign(out, position)
  );
  const images = vi.spyOn(context, 'drawImage');
  drawLaserBolts(
    [{ position: { x: 50, y: 50 }, velocity: { x: 1, y: 0 }, explodeTime: 0 }],
    '#ffffff',
    { x: 0, y: 0 }
  );
  expect(images).not.toHaveBeenCalled();
  expect(context.getImageData(50, 50, 1, 1).data[3]).toBeGreaterThan(0);
  expect(readBitmapBudget().deniedAllocations).toBeGreaterThan(denied);
});

test('a lost recycled context retires its pixels before replacement, and failed resizes release the old charge', () => {
  const before = readBitmapBudget().liveBytes;
  const first = prepareRasterSurface(20, 30, undefined, 'context-loss-test');
  if (!first) {
    throw new Error('Expected first artwork');
  }
  Object.defineProperty(first.context, 'isContextLost', { configurable: true, value: () => true });
  const replacement = prepareRasterSurface(10, 10, first, 'context-loss-test');
  if (!replacement) {
    throw new Error('Expected replacement artwork');
  }
  expect(first.canvas.width).toBe(0);
  expect(replacement.canvas).not.toBe(first.canvas);
  expect(readBitmapBudget().liveBytes).toBe(before + 400);
  vi.spyOn(replacement.canvas, 'width', 'set').mockImplementationOnce(() => {
    throw new Error('Resize refused');
  });
  expect(() => resizeBitmap(replacement.canvas, 30, 10, 'context-loss-test')).toThrow(
    'Resize refused'
  );
  expect(readBitmapBudget().liveBytes).toBe(before);
});

test('a failed pickup blit keeps its bitmap owned until explicit runtime cleanup', () => {
  clearLootArtwork();
  const before = readBitmapBudget().liveBytes;
  const target = canvas();
  target.width = 200;
  target.height = 100;
  const context = target.getContext('2d');
  if (!context) {
    throw new Error('Expected painter');
  }
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(context);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 200, height: 100 });
  vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out, position) =>
    Object.assign(out, position)
  );
  vi.spyOn(context, 'drawImage').mockImplementationOnce(() => {
    throw new Error('Blit refused');
  });
  const transform = context.getTransform();
  expect(() =>
    drawLootRelative(new Ship(), [
      { id: 'failed-blit', position: { x: 50, y: 50 }, kind: 'points', radius: 14, mass: 0 },
    ])
  ).toThrow('Blit refused');
  expect(context.getTransform()).toEqual(transform);
  expect(readBitmapBudget().liveBytes).toBeGreaterThan(before);
  clearLootArtwork();
  expect(readBitmapBudget().liveBytes).toBe(before);
});

test('map legends release their owned bitmap when initial painting fails', () => {
  const target = canvas();
  const before = readBitmapBudget().liveBytes;
  vi.spyOn(target, 'getContext').mockImplementationOnce(() => {
    throw new Error('Legend paint failed');
  });
  expect(() => paintMapLegend(target, 'Uncharted')).toThrow('Legend paint failed');
  expect(target.width).toBe(0);
  expect(readBitmapBudget().liveBytes).toBe(before);
});
