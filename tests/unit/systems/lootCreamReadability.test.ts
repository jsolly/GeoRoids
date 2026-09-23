import { afterEach, expect, test, vi } from 'vitest';

import { GROWTH } from '../../../shared/shipGrowth';
import { PALETTE, VISUAL } from '../../../src/constants';
import { LootField } from '../../../src/entities/loot/LootField';
import { drawLootRelative, lootScreenRadius } from '../../../src/entities/loot/lootRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { HAULER_TETHER_COLOR } from '../../../src/entities/ship/shipKits';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvasSurface';

type TraceContext = CanvasRenderingContext2D & { lineToCount: number };

function traceContext(): TraceContext {
  let ctx = {} as TraceContext;
  ctx = {
    lineToCount: 0,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => {
      ctx.lineToCount += 1;
    },
    closePath: () => undefined,
    stroke: () => undefined,
  } as unknown as TraceContext;
  return ctx;
}

afterEach(() => {
  LootField.getInstance().clear();
  vi.restoreAllMocks();
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
  const ctx = traceContext();
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
  expect(ctx.lineToCount).toBe(45);
});

test('silk snapshots draw three looped filaments instead of mineral diamonds', () => {
  const ctx = traceContext();
  ctx.quadraticCurveTo = vi.fn();
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
  expect(ctx.quadraticCurveTo).toHaveBeenCalledTimes(18);
  expect(ctx.lineToCount).toBe(0);
  expect(ctx.strokeStyle).toBe(PALETTE.LOOT);
});

test('rare equipment retains its identity and floats with a large labeled silhouette', () => {
  const ctx = traceContext();
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
