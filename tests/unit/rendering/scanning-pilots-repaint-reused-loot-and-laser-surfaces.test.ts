import { afterEach, expect, test, vi } from 'vitest';
import type { LootData } from '../../../shared-types';
import { drawLootRelative } from '../../../src/entities/loot/lootRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { drawLaserBolts } from '../../../src/entities/ship/shipRenderer';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';

afterEach(() => {
  drawLootRelative(new Ship(), []);
  configureRenderQuality('', false);
  vi.restoreAllMocks();
});

function scene() {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Missing scene canvas');
  }
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 400, height: 200 });
  const scale = vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );
  vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out, position) =>
    Object.assign(out, position)
  );
  const images = vi.spyOn(ctx, 'drawImage');
  const created: HTMLCanvasElement[] = [];
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name, options) => {
    const element = createElement(name, options);
    if (element instanceof HTMLCanvasElement) {
      created.push(element);
    }
    return element;
  });
  return {
    ctx,
    images,
    created,
    scale,
    clear(dpr: number) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      images.mockClear();
    },
    pixels: () => [...ctx.getImageData(0, 0, 400, 200).data],
    sources() {
      return images.mock.calls.map(([source]) => {
        if (!(source instanceof HTMLCanvasElement)) {
          throw new Error('Expected cached raster artwork');
        }
        return source;
      });
    },
  };
}

function poison(canvas: HTMLCanvasElement): void {
  const paint = canvas.getContext('2d');
  if (!paint) {
    throw new Error('Missing sprite painter');
  }
  paint.save();
  paint.beginPath();
  paint.rect(0, 0, 1, 1);
  paint.clip();
  paint.globalAlpha = 0;
}

test('a scanning pilot keeps mixed pickup styles independent while reusing and fully repainting their old surfaces', () => {
  const view = scene();
  const ship = new Ship();
  drawLootRelative(ship, []);
  const drops: LootData[] = [
    { id: 'points-a', position: { x: 50, y: 60 }, kind: 'points', radius: 14, mass: 0 },
    { id: 'dense-shard', position: { x: 110, y: 60 }, kind: 'shard', radius: 14, mass: 1 },
    { id: 'silk', position: { x: 180, y: 60 }, kind: 'silk', radius: 22, mass: 0 },
    { id: 'points-b', position: { x: 250, y: 60 }, kind: 'points', radius: 14, mass: 0 },
    { id: 'thin-shard', position: { x: 320, y: 60 }, kind: 'shard', radius: 14, mass: 0.1 },
  ];
  view.clear(1);
  drawLootRelative(ship, drops);
  const baseline = view.pixels();
  expect(baseline.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
  expect(view.created).toHaveLength(4);
  for (const dpr of [1.123456, 1.123457, 3, 1]) {
    view.created.forEach(poison);
    view.clear(dpr);
    drawLootRelative(ship, drops);
    const sources = view.sources();
    expect(sources).toHaveLength(5);
    expect(sources[0]).toBe(sources[3]);
    expect(new Set(sources).size).toBe(4);
    expect(view.created).toHaveLength(4);
    expect(sources.every((canvas) => canvas.getContext('2d')?.globalAlpha === 1)).toBe(true);
  }
  expect(view.pixels()).toEqual(baseline);
  const originalPoint = view.sources()[0];
  const point = drops[0];
  if (!point) {
    throw new Error('Missing ordinary point drop');
  }
  // A newly visible style cannot recycle a still-live style used again later in the batch.
  view.clear(1);
  drawLootRelative(ship, [
    point,
    { ...point, id: 'wreckage', kind: 'wreckage', position: { x: 110, y: 60 } },
    { ...point, id: 'points-c', position: { x: 180, y: 60 } },
  ]);
  expect(view.sources()[0]).toBe(originalPoint);
  expect(view.sources()[2]).toBe(originalPoint);
  expect(view.sources()[1]).not.toBe(originalPoint);
  expect(view.created.filter((canvas) => canvas.width > 0)).toHaveLength(2);
  // A hidden style has no retained old-zoom handle after the next presentation batch.
  view.clear(2);
  drawLootRelative(ship, [point]);
  expect(view.created.filter((canvas) => canvas.width > 0)).toHaveLength(1);
  drawLootRelative(ship, []);
  expect(view.created.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

test('a scanning pilot repaints both friendly and bounced laser colors without retaining old DPR or color histories', () => {
  const view = scene();
  const lasers = [
    { position: { x: 70, y: 60 }, velocity: { x: 1, y: 0 }, explodeTime: 0 },
    { position: { x: 150, y: 60 }, velocity: { x: 0, y: 1 }, explodeTime: 0, bounceCount: 1 },
    { position: { x: 230, y: 60 }, velocity: { x: 1, y: 0 }, explodeTime: 0 },
  ];
  const draw = (color = '#AB12CD') => drawLaserBolts(lasers, color, { x: 0, y: 0 });
  view.clear(1);
  draw();
  const baseline = view.pixels();
  expect(baseline.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
  expect(view.created).toHaveLength(2);
  for (const dpr of [1.123456, 1.123457, 3, 1]) {
    view.created.forEach(poison);
    view.clear(dpr);
    draw();
    const sources = view.sources();
    expect(sources[0]).toBe(sources[2]);
    expect(sources[0]).not.toBe(sources[1]);
    expect(view.created).toHaveLength(2);
    expect(sources.every((canvas) => canvas.getContext('2d')?.globalAlpha === 1)).toBe(true);
  }
  expect(view.pixels()).toEqual(baseline);
  view.clear(1);
  draw('#21CDAB');
  expect(view.created).toHaveLength(2);
  expect(view.pixels()).not.toEqual(baseline);
  configureRenderQuality('?performance=collect&renderGlow=off', false);
  const widths = view.sources().map((canvas) => canvas.width);
  view.clear(1);
  draw('#21CDAB');
  expect(view.created).toHaveLength(2);
  expect(view.sources().some((canvas, index) => canvas.width < (widths[index] ?? 0))).toBe(true);
});
