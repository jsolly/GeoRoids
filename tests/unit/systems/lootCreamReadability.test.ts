import { afterEach, expect, test, vi } from 'vitest';
import { GROWTH } from '../../../shared/shipGrowth';
import type { LootData } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../../src/constants';
import { LootField } from '../../../src/entities/loot/LootField';
import { drawLootRelative, lootScreenRadius } from '../../../src/entities/loot/lootRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { HAULER_TETHER_COLOR } from '../../../src/entities/ship/shipKits';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';

function traceContext() {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  const artwork: {
    lines: number;
    curves: number;
    strokes: Array<{ color: string | CanvasGradient | CanvasPattern; width: number; blur: number }>;
  } = {
    lines: 0,
    curves: 0,
    strokes: [],
  };
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name, options) => {
    const element = createElement(name, options);
    if (element instanceof HTMLCanvasElement) {
      const painter = element.getContext('2d');
      if (!painter) {
        throw new Error('Loot artwork context unavailable');
      }
      const lineTo = painter.lineTo.bind(painter);
      const curveTo = painter.quadraticCurveTo.bind(painter);
      const stroke = painter.stroke.bind(painter);
      vi.spyOn(painter, 'lineTo').mockImplementation((...args) => {
        artwork.lines += 1;
        lineTo(...args);
      });
      vi.spyOn(painter, 'quadraticCurveTo').mockImplementation((...args) => {
        artwork.curves += 1;
        curveTo(...args);
      });
      vi.spyOn(painter, 'stroke').mockImplementation(() => {
        artwork.strokes.push({
          color: painter.strokeStyle,
          width: painter.lineWidth,
          blur: painter.shadowBlur,
        });
        stroke();
      });
    }
    return element;
  });
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 800, height: 600 });
  return { ctx, artwork };
}

afterEach(() => {
  LootField.getInstance().clear();
  vi.restoreAllMocks();
  configureRenderQuality('', false);
});

test('wreckage and shards share locked cream', () => {
  expect(PALETTE.LOOT).toBe('#E8D5A3');
  expect(PALETTE.LOOT).toBe(HAULER_TETHER_COLOR);
});

test('loot geometry rejects invalid radii and keeps tiny valid drops visible', () => {
  expect(lootScreenRadius(Number.NaN, 1)).toBeNull();
  expect(lootScreenRadius(0, 1)).toBeNull();
  expect(lootScreenRadius(-1, 1)).toBeNull();
  expect(lootScreenRadius(GROWTH.LOOT_RADIUS, 0)).toBeNull();
  expect(lootScreenRadius(GROWTH.LOOT_RADIUS, 0.1)).toBe(VISUAL.LOOT_MIN_SCREEN_PX);
  expect(lootScreenRadius(80, 0.1)).toBe(8);
});

test('cream loot uses a restrained stroke and a stronger void separation layer', () => {
  expect(VISUAL.LOOT_STROKE_WIDTH).toBeGreaterThan(VISUAL.SHIP_STROKE_WIDTH);
  expect(VISUAL.LOOT_UNDERSTROKE).toBeGreaterThan(VISUAL.LOOT_STROKE_WIDTH);
  expect(VISUAL.LOOT_GLOW).toBeLessThanOrEqual(VISUAL.LOOT_STROKE_WIDTH);
  expect(VISUAL.LOOT_SHARD_INNER).toBeGreaterThan(0.3);
  expect(VISUAL.LOOT_SHARD_INNER).toBeLessThan(0.6);
  expect(VISUAL.LOOT_SHARD_DENSE_INNER).toBeGreaterThan(VISUAL.LOOT_SHARD_INNER);
});

test('dense metal shards get a second readable inner outline', () => {
  const { ctx, artwork } = traceContext();
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );

  drawLootRelative(new Ship(), [
    {
      id: 'normal-shard',
      position: { x: 20, y: 20 },
      mass: 0.25,
      radius: GROWTH.LOOT_RADIUS,
      kind: 'shard',
    },
    {
      id: 'dense-shard',
      position: { x: 40, y: 20 },
      mass: 0.75,
      radius: GROWTH.LOOT_RADIUS,
      kind: 'shard',
    },
  ]);

  // Every visible drop is traced three times (void, glow, cream). The dense
  // shard contributes one extra diamond to each pass.
  expect(artwork.lines).toBe(45);
  expect(artwork.strokes.map(({ width }) => width)).toEqual([
    VISUAL.LOOT_UNDERSTROKE,
    VISUAL.LOOT_STROKE_WIDTH,
    VISUAL.LOOT_STROKE_WIDTH,
    VISUAL.LOOT_UNDERSTROKE,
    VISUAL.LOOT_STROKE_WIDTH,
    VISUAL.LOOT_STROKE_WIDTH,
  ]);
});

test('silk snapshots draw three looped filaments instead of mineral diamonds', () => {
  const { ctx, artwork } = traceContext();
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );
  const field = LootField.getInstance();
  field.applySnapshot([
    { id: 'silk-1', position: { x: 30, y: 30 }, mass: 0, radius: 20, kind: 'silk' },
  ]);
  drawLootRelative(new Ship(), field.getAll());
  expect(field.getAll()[0]?.kind).toBe('silk');
  expect(artwork.curves).toBe(18);
  expect(artwork.lines).toBe(0);
  expect(artwork.strokes.at(-1)?.color).toBe(PALETTE.LOOT.toLowerCase());
});

test('ordinary loot reuses artwork, keeps edge halos and rebuilds for display quality', () => {
  const { ctx, artwork } = traceContext();
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );
  const images = vi.spyOn(ctx, 'drawImage');
  const ship = new Ship();
  const drops: LootData[] = [
    { id: 'left-halo', position: { x: -15, y: 40 }, mass: 0, radius: 14, kind: 'points' },
    { id: 'center', position: { x: 40, y: 40 }, mass: 0, radius: 14, kind: 'points' },
    { id: 'offscreen', position: { x: -100, y: 40 }, mass: 0, radius: 14, kind: 'points' },
  ];
  drawLootRelative(ship, drops);
  expect(images).toHaveBeenCalledTimes(2);
  expect(images.mock.calls[0]?.[0]).toBe(images.mock.calls[1]?.[0]);
  expect(artwork.strokes.map(({ blur }) => blur)).toEqual([0, VISUAL.LOOT_GLOW, 0]);
  expect(artwork.strokes[0]?.color).toBe(PALETTE.BG.toLowerCase());
  drawLootRelative(ship, drops);
  expect(images).toHaveBeenCalledTimes(4);
  expect(artwork.strokes).toHaveLength(3);
  expect(images.mock.calls[2]?.[0]).toBe(images.mock.calls[0]?.[0]);

  ctx.setTransform(2, 0, 0, 2, 0, 0);
  drawLootRelative(ship, drops);
  const denser = images.mock.calls[4]?.[0];
  expect(denser).not.toBe(images.mock.calls[0]?.[0]);
  if (!(denser instanceof HTMLCanvasElement)) {
    throw new Error('DPR change did not rebuild loot artwork');
  }
  expect(denser.getContext('2d')?.getTransform().a).toBe(2);
  configureRenderQuality('?performance=1&renderGlow=off', false);
  drawLootRelative(ship, drops);
  const noGlow = images.mock.calls[6]?.[0];
  if (!(noGlow instanceof HTMLCanvasElement)) {
    throw new Error('Glow change did not rebuild loot artwork');
  }
  expect(noGlow).not.toBe(denser);
  expect(noGlow.width).toBeLessThan(denser.width);

  const fillText = vi.spyOn(ctx, 'fillText');
  drawLootRelative(ship, [
    { id: 'edge-label', position: { x: -30, y: 40 }, mass: 0, radius: 22, kind: 'boost_coupling' },
  ]);
  expect(fillText).toHaveBeenCalledWith('BOOST COUPLING', -30, expect.any(Number));
});

test('rare equipment retains its identity and floats with a large labeled silhouette', () => {
  const { ctx } = traceContext();
  ctx.moveTo = vi.fn();
  ctx.fillText = vi.fn();
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const field = LootField.getInstance();
  field.applySnapshot([
    { id: 'equipment-1', position: { x: 0, y: 0 }, mass: 0, radius: 22, kind: 'boost_coupling' },
  ]);
  drawLootRelative(new Ship(), field.getAll());
  expect(field.getAll()[0]?.kind).toBe('boost_coupling');
  expect(ctx.fillText).toHaveBeenCalledWith('BOOST COUPLING', 0, expect.any(Number));
  const firstY = vi.mocked(ctx.moveTo).mock.calls[0]?.[1];
  vi.mocked(ctx.moveTo).mockClear();
  vi.mocked(performance.now).mockReturnValue((450 * Math.PI) / 2);
  drawLootRelative(new Ship(), field.getAll());
  expect(vi.mocked(ctx.moveTo).mock.calls[0]?.[1]).toBeGreaterThan(firstY ?? 0);
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  vi.mocked(ctx.moveTo).mockClear();
  drawLootRelative(new Ship(), field.getAll());
  expect(vi.mocked(ctx.moveTo).mock.calls[0]?.[1]).toBe(firstY);
});
