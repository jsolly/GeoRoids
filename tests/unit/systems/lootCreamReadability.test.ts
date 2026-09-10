import { afterEach, expect, test, vi } from 'vitest';

import { PALETTE, VISUAL } from '../../../src/constants';
import { LootField } from '../../../src/entities/loot/LootField';
import {
  drawLootRelative,
  lootScreenRadius,
  lootStrokeColor,
} from '../../../src/entities/loot/lootRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { HAULER_TETHER_COLOR } from '../../../src/entities/ship/shipKits';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvas';

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

test('wreckage and shards share locked cream; fuel stays health green', () => {
  expect(lootStrokeColor('wreckage')).toBe(PALETTE.LOOT);
  expect(lootStrokeColor('shard')).toBe(PALETTE.LOOT);
  expect(lootStrokeColor('fuel')).toBe(PALETTE.HEALTH);
  expect(PALETTE.LOOT).toBe('#E8D5A3');
  expect(PALETTE.LOOT).toBe(HAULER_TETHER_COLOR);
});

test('loot geometry rejects invalid radii and keeps tiny valid drops visible', () => {
  expect(lootScreenRadius(Number.NaN, 1)).toBeNull();
  expect(lootScreenRadius(0, 1)).toBeNull();
  expect(lootScreenRadius(-1, 1)).toBeNull();
  expect(lootScreenRadius(7, 0)).toBeNull();
  expect(lootScreenRadius(7, 0.1)).toBe(VISUAL.LOOT_MIN_SCREEN_PX);
  expect(lootScreenRadius(40, 0.1)).toBe(4);
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
    { id: 'normal-shard', position: { x: 20, y: 20 }, mass: 0.25, radius: 7, kind: 'shard' },
    { id: 'dense-shard', position: { x: 40, y: 20 }, mass: 0.75, radius: 7, kind: 'shard' },
  ]);

  // Every visible drop is traced three times (void, glow, cream). The dense
  // shard contributes one extra diamond to each pass.
  expect(ctx.lineToCount).toBe(45);
});

test('shield remains independent mint rather than health green', () => {
  expect(PALETTE.SHIELD).toBe('#7DD3C8');
  expect(PALETTE.SHIELD).not.toBe(PALETTE.LOCAL);
  expect(PALETTE.SHIELD).not.toBe(PALETTE.REMOTE);
  expect(PALETTE.SHIELD).not.toBe(PALETTE.HEALTH);
});
