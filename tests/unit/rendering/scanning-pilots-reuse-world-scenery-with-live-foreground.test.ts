import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as terrainField from '../../../shared/terrainField';
import type { Position } from '../../../shared-types';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { RoidBelt } from '../../../src/entities/roid/Roid';
import * as shipPainter from '../../../src/entities/ship/shipRenderer';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import type { ContourLevel } from '../../../src/physics/terrain/contours';
import * as terrain from '../../../src/physics/terrain/terrainSession';
import { drawGame } from '../../../src/rendering/canvas';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import * as contourPainter from '../../../src/rendering/contourRenderer';
import { GpuRearRenderer } from '../../../src/rendering/gpuRearRenderer';
import { prepareRasterSurface } from '../../../src/rendering/rasterSurface';
import {
  SCAN_SCENERY_MAX_PIXELS,
  ScanSceneryCache,
  type ScanSceneryCamera,
  scanSceneryMode,
} from '../../../src/rendering/scanSceneryCache';
import { TestPath2D } from '../../support/TestPath2D';
import { setWindowViewport } from '../../support/viewport';

const levels: ContourLevel[] = [
  { index: 0, height: 0, segments: [{ ax: -90, ay: 40, bx: -30, by: 70 }] },
];
let cache: ScanSceneryCache;
let context: CanvasRenderingContext2D;
let restoreViewport = () => {};
let originalUrl = '';
const strokes: Array<{ context: CanvasRenderingContext2D; transform: DOMMatrix }> = [];
const contexts = new WeakSet<CanvasRenderingContext2D>();

function recordNativePaths(ctx: CanvasRenderingContext2D): void {
  if (contexts.has(ctx)) {
    return;
  }
  contexts.add(ctx);
  const nativeStroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'stroke').mockImplementation((...paths: [] | [Path2D]) => {
    const path = paths[0];
    if (path instanceof TestPath2D) {
      strokes.push({ context: ctx, transform: ctx.getTransform() });
      ctx.beginPath();
      for (const command of path.commands) {
        ctx[command.kind](command.x, command.y);
      }
      nativeStroke();
    } else {
      Reflect.apply(nativeStroke, ctx, paths);
    }
  });
}

beforeEach(() => {
  originalUrl = window.location.href;
  restoreViewport = setWindowViewport(800, 1094, 1.5);
  vi.stubGlobal('Path2D', TestPath2D);
  vi.spyOn(terrain, 'peekBuiltContourRegion').mockReturnValue({
    levels,
    bounds: { cx: 0, cy: 0, radius: 100_000, gridSize: 96 },
  });
  // Execute the production painter; the test Path2D publishes its commands to node-canvas.
  const paint = contourPainter.drawContourLayers;
  vi.spyOn(contourPainter, 'drawContourLayers').mockImplementation((ctx, ...args) => {
    recordNativePaths(ctx);
    return paint(ctx, ...args);
  });
  const canvas = document.createElement('canvas');
  const mainContext = canvas.getContext('2d');
  if (!mainContext) {
    throw new Error('Missing scenery test canvas');
  }
  context = mainContext;
  cache = new ScanSceneryCache();
  strokes.length = 0;
});

afterEach(() => {
  cache.dispose();
  canvasManager.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreViewport();
  window.history.replaceState({}, '', originalUrl);
});

function camera(zoom = 800 / 2760, dpr = 1.5): ScanSceneryCamera {
  return {
    screen: { width: 800, height: 1094 },
    viewport: { width: 800 / zoom, height: 1094 / zoom },
    zoom,
    wideZoom: 800 / 2760,
    dpr,
    scale: 1,
  };
}

function draw(position: Position = { x: 0, y: 0 }, frame = camera()) {
  return cache.draw(context, position, frame);
}

test('stationary wide scans reuse a complete rear without restroking contours', () => {
  const images = vi.spyOn(context, 'drawImage');
  expect(draw()).toEqual({ kind: 'built', cause: 'cold' });
  expect(strokes).toHaveLength(1);
  expect(draw()).toEqual({ kind: 'cached' });
  expect(strokes).toHaveLength(1);
  expect(images).toHaveBeenCalledTimes(2);
  expect(cache.getStats().ownedPixels).toBeGreaterThan(2_000_000);
  expect(cache.getStats().ownedPixels).toBeLessThan(2_400_000);
  expect(cache.getStats().peakOwnedPixels).toBe(cache.getStats().ownedPixels);
});

test.each([1, 1.5, 2, 3])(
  'camera pan and eased zoom preserve a known world endpoint at DPR %s',
  (dpr) => {
    const initial =
      dpr === 3
        ? {
            ...camera(0.5, dpr),
            screen: { width: 400, height: 547 },
            viewport: { width: 800, height: 1094 },
            wideZoom: 400 / 2760,
          }
        : camera(0.5, dpr);
    const position = { x: -100, y: 20 };
    const images: Array<{
      source: CanvasImageSource;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    vi.spyOn(context, 'drawImage').mockImplementation((source, ...args: number[]) => {
      const [x, y, width, height] = args;
      if (x === undefined || y === undefined || width === undefined || height === undefined) {
        throw new Error('Expected an explicitly sized scenery composite');
      }
      images.push({ source, x, y, width, height });
    });
    context.setTransform(dpr * initial.zoom, 0, 0, dpr * initial.zoom, 0, 0);
    expect(draw(position, initial).kind).toBe('built');
    const paint = strokes[0];
    const image = images[0];
    if (!paint || !image || !(image.source instanceof HTMLCanvasElement)) {
      throw new Error('Missing actual scenery paint and composite');
    }
    const sourceX = paint.transform.a * -90 + paint.transform.e;
    const sourceY = paint.transform.d * 40 + paint.transform.f;
    const observedX = (image.x + (sourceX / image.source.width) * image.width) * dpr * initial.zoom;
    const observedY =
      (image.y + (sourceY / image.source.height) * image.height) * dpr * initial.zoom;
    const halfWidth = dpr === 3 ? 200 : 400;
    const halfHeight = dpr === 3 ? 273.5 : 547;
    expect(observedX).toBeCloseTo((halfWidth + 5) * dpr, 8);
    expect(observedY).toBeCloseTo((halfHeight + 10) * dpr, 8);
    const moved = { x: -99, y: 21 };
    const later = {
      ...initial,
      zoom: 0.4,
      viewport: { width: initial.screen.width / 0.4, height: initial.screen.height / 0.4 },
    };
    context.setTransform(dpr * later.zoom, 0, 0, dpr * later.zoom, 0, 0);
    expect(draw(moved, later)).toEqual({ kind: 'cached' });
    const next = images[1];
    if (!next) {
      throw new Error('Missing reused scenery composite');
    }
    expect((next.x + (sourceX / image.source.width) * next.width) * dpr * later.zoom).toBeCloseTo(
      (halfWidth + 9 * 0.4) * dpr,
      8
    );
    expect((next.y + (sourceY / image.source.height) * next.height) * dpr * later.zoom).toBeCloseTo(
      (halfHeight + 19 * 0.4) * dpr,
      8
    );
    expect(context.getTransform().a).toBeCloseTo(dpr * later.zoom);
  }
);

test('cached rear composition ignores inherited glow and opacity then restores drawing state', () => {
  context.globalAlpha = 0.5;
  context.shadowBlur = 7;
  context.shadowColor = '#ff0000';
  context.globalCompositeOperation = 'lighter';
  const nativeImage = context.drawImage.bind(context);
  const composite = vi.spyOn(context, 'drawImage').mockImplementation((...args) => {
    expect(context.globalAlpha).toBe(1);
    expect(context.shadowBlur).toBe(0);
    expect(context.globalCompositeOperation).toBe('source-over');
    Reflect.apply(nativeImage, context, args);
  });
  expect(draw().kind).toBe('built');
  expect(composite).toHaveBeenCalledOnce();
  expect(context.globalAlpha).toBe(0.5);
  expect(context.shadowBlur).toBe(7);
  expect(context.globalCompositeOperation).toBe('lighter');
});

test('pan replacements count both backing stores and release the previous one', () => {
  const images = vi.spyOn(context, 'drawImage');
  expect(draw().kind).toBe('built');
  const firstPixels = cache.getStats().ownedPixels;
  const firstImage = images.mock.calls[0]?.[0];
  expect(draw({ x: 100, y: 0 })).toEqual({ kind: 'built', cause: 'pan' });
  expect(cache.getStats().peakOwnedPixels).toBeGreaterThan(firstPixels);
  expect(cache.getStats().peakOwnedPixels).toBeLessThanOrEqual(SCAN_SCENERY_MAX_PIXELS);
  expect(cache.getStats().ownedPixels).toBeLessThan(cache.getStats().peakOwnedPixels);
  if (!(firstImage instanceof HTMLCanvasElement)) {
    throw new Error('Missing retained first buffer');
  }
  expect(firstImage.width).toBe(0);
  expect(firstImage.height).toBe(0);
});

test('a teleport with no complete source never blits the previous terrain into uncovered space', () => {
  const images = vi.spyOn(context, 'drawImage');
  expect(draw().kind).toBe('built');
  vi.mocked(terrain.peekBuiltContourRegion).mockReturnValue(undefined);
  expect(draw({ x: 10_000, y: -20_000 })).toEqual({ kind: 'fallback', reason: 'source' });
  expect(images).toHaveBeenCalledTimes(1);
  // The original image still serves a fully covered correction back to the old camera.
  expect(draw({ x: 1, y: -1 })).toEqual({ kind: 'cached' });
  expect(images).toHaveBeenCalledTimes(2);
});

test('cold source misses do not extract or prefetch speculative terrain', () => {
  vi.mocked(terrain.peekBuiltContourRegion).mockReturnValue(undefined);
  const builds = vi.spyOn(terrain, 'getTerrainContours');
  expect(draw()).toEqual({ kind: 'fallback', reason: 'source' });
  expect(builds).not.toHaveBeenCalled();
  expect(cache.getStats().ownedPixels).toBe(0);
});

test.each([
  { size: 2800, dpr: 1, reason: 'pixel-limit' },
  { size: 2000, dpr: 3, reason: 'dimension-limit' },
])('a $reason fails before allocating an oversized buffer', ({ size, dpr, reason }) => {
  const create = vi.spyOn(document, 'createElement');
  const frame = {
    ...camera(),
    screen: { width: size, height: size },
    viewport: { width: size / 0.3, height: size / 0.3 },
    wideZoom: 0.3,
    dpr,
  };
  expect(draw({ x: 0, y: 0 }, frame)).toEqual({ kind: 'fallback', reason });
  expect(create).not.toHaveBeenCalled();
  expect(cache.getStats().ownedPixels).toBe(0);
  expect(draw({ x: 1, y: 0 }, frame)).toEqual({ kind: 'fallback', reason });
});

test('active plus replacement buffers obey the peak cap even when either fits alone', () => {
  const frame = {
    ...camera(),
    screen: { width: 2000, height: 2000 },
    viewport: { width: 2000 / 0.3, height: 2000 / 0.3 },
    wideZoom: 0.3,
    dpr: 1,
  };
  expect(draw({ x: 0, y: 0 }, frame).kind).toBe('built');
  expect(draw({ x: 100, y: 0 }, frame)).toEqual({ kind: 'fallback', reason: 'pixel-limit' });
  expect(cache.getStats().peakOwnedPixels).toBeLessThanOrEqual(SCAN_SCENERY_MAX_PIXELS);
  expect(cache.getStats().ownedPixels).toBe(0);
});

test('a composite failure releases backing memory and disables repeated allocations', () => {
  vi.spyOn(context, 'drawImage').mockImplementation(() => {
    throw new Error('Composite failure');
  });
  expect(draw()).toEqual({ kind: 'fallback', reason: 'composite' });
  expect(cache.getStats().ownedPixels).toBe(0);
  const create = vi.spyOn(document, 'createElement');
  expect(draw()).toEqual({ kind: 'fallback', reason: 'composite' });
  expect(create).not.toHaveBeenCalled();
});

test('a paint failure disposes the unpublished allocation', () => {
  vi.mocked(contourPainter.drawContourLayers).mockImplementation(() => {
    throw new Error('Raster paint failure');
  });
  expect(draw()).toEqual({ kind: 'fallback', reason: 'paint' });
  expect(cache.getStats().ownedPixels).toBe(0);
});

test('field and projection changes build cold while releasing obsolete surfaces', () => {
  const images = vi.spyOn(context, 'drawImage');
  expect(draw().kind).toBe('built');
  const first = images.mock.calls[0]?.[0];
  const field = terrainField.getTerrainField();
  vi.spyOn(terrainField, 'getTerrainField').mockReturnValue({ ...field, seed: field.seed + 1 });
  expect(draw()).toEqual({ kind: 'built', cause: 'cold' });
  expect(first).toMatchObject({ width: 0, height: 0 });
  expect(draw({ x: 0, y: 0 }, camera(0.4, 2))).toEqual({ kind: 'built', cause: 'cold' });
  const resized = {
    ...camera(),
    screen: { width: 1094, height: 800 },
    viewport: { width: 1094 / (800 / 2760), height: 2760 },
  };
  expect(draw({ x: 0, y: 0 }, resized)).toEqual({ kind: 'built', cause: 'cold' });
  cache.dispose();
  expect(cache.getStats().ownedPixels).toBe(0);
  expect(draw()).toEqual({ kind: 'fallback', reason: 'disabled' });
});

test.each(['null', 'throw'])(
  'a %s context allocation releases its canvas before failing',
  (failure) => {
    const canvas = document.createElement('canvas');
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    vi.spyOn(canvas, 'getContext').mockImplementation(() => {
      if (failure === 'throw') {
        throw new Error('Context allocation failed');
      }
      return null;
    });
    expect(() => prepareRasterSurface(1000, 1200, undefined, 'Missing context')).toThrow();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(draw()).toEqual({ kind: 'fallback', reason: 'allocation' });
    expect(cache.getStats().ownedPixels).toBe(0);
  }
);

test('the diagnostic query is opt-in and rejects an invalid explicit mode', () => {
  expect(scanSceneryMode('?scanScenery=cache')).toBe('native');
  expect(scanSceneryMode('?performance=collect')).toBe('native');
  expect(scanSceneryMode('?performance=1&scanScenery=native')).toBe('native');
  expect(scanSceneryMode('?performance=collect&scanScenery=cache')).toBe('cache');
  expect(() => scanSceneryMode('?performance=1&scanScenery=other')).toThrow('scanScenery');
});

test('a cached scan keeps foreground firing and HUD live, then releases storage on flight and destroy', () => {
  window.history.replaceState({}, '', '?performance=collect&scanScenery=cache');
  vi.spyOn(terrain, 'getTerrainContours').mockReturnValue(levels);
  const lasers = vi.spyOn(shipPainter, 'drawLasers');
  const outcomes = vi.spyOn(clientPerformance, 'setSceneryFrame');
  const network = ConnectionManager.getInstance();
  const players = PlayerManager.getInstance({
    networkPort: network,
    combatNetwork: network.combatNetwork,
  });
  const pilot = players.createLocalPlayer('scout');
  pilot.id = 'cache-pilot';
  pilot.ship.abilityActiveFrames = 120;
  pilot.ship.position = { x: 0, y: 0 };
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  const ctx = canvasManager.requireContext();
  const hud = vi.spyOn(ctx, 'fillText');
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const belt = new RoidBelt();
  drawGame(pilot, belt, [pilot]);
  now.mockReturnValue(100);
  drawGame(pilot, belt, [pilot]);
  expect(outcomes).toHaveBeenLastCalledWith({ kind: 'built', cause: 'cold' });
  const painted = strokes.length;
  now.mockReturnValue(116);
  drawGame(pilot, belt, [pilot]);
  expect(outcomes).toHaveBeenLastCalledWith({ kind: 'cached' });
  expect(strokes.length).toBe(painted);
  expect(lasers).toHaveBeenCalledTimes(3);
  expect(hud.mock.calls.filter(([text]) => text.startsWith('Bank '))).toHaveLength(3);
  expect(canvasManager.getViewportSize()).toEqual({ width: 800, height: 1094 });
  expect(ctx.getTransform()).toMatchObject({ a: 1.5, d: 1.5, e: 0, f: 0 });
  for (let tick = 1; tick <= 30; tick++) {
    canvasManager.easeZoomToward(1, 116 + tick * 100);
  }
  expect(canvasManager.getScanSceneryStats().ownedPixels).toBe(0);
  canvasManager.destroy();
  expect(canvasManager.getScanSceneryStats().ownedPixels).toBe(0);
});

test('the real 3072 terrain patch supplies bounded scan scenery and native recovery without speculative extraction', () => {
  vi.mocked(terrain.peekBuiltContourRegion).mockRestore();
  recordNativePaths(context);
  const prior = terrainField.getTerrainField();
  const frame = camera();
  const radius = Math.hypot(frame.viewport.width / 2, frame.viewport.height / 2) + 32;
  const images = vi.spyOn(context, 'drawImage');
  try {
    terrainField.ensureTerrain(42, { cx: 0, cy: 0, radius: 60_000 });
    expect(draw()).toEqual({ kind: 'fallback', reason: 'source' });
    expect(terrain.builtContourPatchCount()).toBe(0);
    expect(
      contourPainter.drawIsoContours(context, { x: 0, y: 0 }, frame.viewport, 1)
    ).toBeGreaterThan(0);
    terrain.stopTerrainPrefetch();
    expect(terrain.builtContourPatchCount()).toBe(1);
    expect(terrain.peekBuiltContourRegion({ x: 0, y: 0 }, radius)?.bounds).toMatchObject({
      radius: 3072,
      gridSize: 96,
    });
    expect(draw()).toEqual({ kind: 'built', cause: 'cold' });
    expect(cache.getStats().sourceRadius).toBe(3072);
    expect(terrain.builtContourPatchCount()).toBe(1);
    expect(draw({ x: 100, y: 0 })).toEqual({ kind: 'built', cause: 'pan' });
    expect(terrain.builtContourPatchCount()).toBe(1);
    const composites = images.mock.calls.length;
    expect(draw({ x: 600, y: 0 })).toEqual({ kind: 'fallback', reason: 'source' });
    expect(images).toHaveBeenCalledTimes(composites);
    expect(terrain.builtContourPatchCount()).toBe(1);
    expect(
      contourPainter.drawIsoContours(context, { x: 600, y: 0 }, frame.viewport, 1)
    ).toBeGreaterThan(0);
    terrain.stopTerrainPrefetch();
    expect(terrain.builtContourPatchCount()).toBe(2);
    expect(draw({ x: 600, y: 0 })).toEqual({ kind: 'built', cause: 'pan' });
    expect(draw({ x: 601, y: 0 })).toEqual({ kind: 'cached' });
    expect(terrain.builtContourPatchCount()).toBe(2);
    expect(cache.getStats().sourceRadius).toBe(3072);
  } finally {
    terrain.stopTerrainPrefetch();
    terrainField.ensureTerrain(prior.seed, { cx: prior.cx, cy: prior.cy, radius: prior.radius });
  }
});

test('finite source edges constrain overscan and reject insufficient sampling support', () => {
  vi.mocked(terrain.peekBuiltContourRegion).mockReturnValue({
    levels,
    bounds: { cx: 0, cy: 0, radius: 1920, gridSize: 96 },
  });
  const images = vi.spyOn(context, 'drawImage');
  expect(draw().kind).toBe('built');
  const paint = strokes[0];
  const image = images.mock.calls[0]?.[0];
  if (!paint || !(image instanceof HTMLCanvasElement)) {
    throw new Error('Missing finite-source raster');
  }
  const left = -paint.transform.e / paint.transform.a;
  const top = -paint.transform.f / paint.transform.d;
  expect(left).toBeGreaterThanOrEqual(-1920);
  expect(top).toBeGreaterThanOrEqual(-1920);
  expect(left + image.width / paint.transform.a).toBeLessThanOrEqual(1920);
  expect(top + image.height / paint.transform.d).toBeLessThanOrEqual(1920);
  expect(cache.getStats().ownedPixels).toBeLessThan(2_200_000);
  cache.reset();
  vi.mocked(terrain.peekBuiltContourRegion).mockReturnValue({
    levels,
    bounds: { cx: 0, cy: 0, radius: camera().viewport.height / 2, gridSize: 96 },
  });
  expect(draw()).toEqual({ kind: 'fallback', reason: 'coverage' });
  expect(images).toHaveBeenCalledTimes(1);
  expect(cache.getStats().ownedPixels).toBe(0);
});

test('a lost retained raster falls back without reusing its storage', () => {
  const images = vi.spyOn(context, 'drawImage');
  expect(draw().kind).toBe('built');
  const image = images.mock.calls[0]?.[0];
  if (!(image instanceof HTMLCanvasElement)) {
    throw new Error('Missing retained raster');
  }
  const retained = image.getContext('2d');
  if (!retained) {
    throw new Error('Missing retained raster context');
  }
  // node-canvas lacks this browser API; inject the external context-loss signal.
  Object.defineProperty(retained, 'isContextLost', { configurable: true, value: () => true });
  expect(draw()).toEqual({ kind: 'fallback', reason: 'allocation' });
  expect(images).toHaveBeenCalledTimes(1);
  expect(image).toMatchObject({ width: 0, height: 0 });
  expect(cache.getStats().ownedPixels).toBe(0);
  expect(draw()).toEqual({ kind: 'fallback', reason: 'allocation' });
});

test('a requested WebGL2 renderer bypasses the prototype after GPU initialization fails', () => {
  window.history.replaceState({}, '', '?performance=collect&scanScenery=cache&renderer=webgl2');
  vi.spyOn(GpuRearRenderer, 'create').mockImplementation(() => {
    throw new Error('Unavailable GPU for requested-backend test');
  });
  const outcomes = vi.spyOn(clientPerformance, 'setSceneryFrame');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  canvasManager.easeZoomToward(800 / 2760, 0);
  canvasManager.easeZoomToward(800 / 2760, 100);
  const ctx = canvasManager.requireContext();
  canvasManager.beginWorldLayers(ctx);
  try {
    expect(canvasManager.drawScanScenery({ x: 0, y: 0 })).toBe(false);
  } finally {
    canvasManager.endWorldLayers(ctx);
  }
  expect(outcomes).toHaveBeenLastCalledWith({ kind: 'fallback', reason: 'backend' });
  expect(terrain.peekBuiltContourRegion).not.toHaveBeenCalled();
  expect(canvasManager.getScanSceneryStats().ownedPixels).toBe(0);
});
