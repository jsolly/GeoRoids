import { expect, test } from 'vitest';
import { GROWTH } from '../../../shared/shipGrowth';
import { PALETTE, VISUAL } from '../../../src/constants';
import { lootStrokeColor, traceTapCanister } from '../../../src/entities/loot/lootRenderer';

test('Tap loot is a cream canister, not a diamond, and is larger than ordinary chips', () => {
  expect(GROWTH.TAP_LOOT_RADIUS / GROWTH.LOOT_RADIUS).toBeGreaterThanOrEqual(2);
  expect(GROWTH.TAP_LOOT_RADIUS / GROWTH.LOOT_RADIUS).toBeLessThanOrEqual(2.5);
  expect(lootStrokeColor('tap')).toBe(PALETTE.LOOT);
  expect(PALETTE.LASER_LOCAL).toBe('#FDE68A');
  expect(VISUAL.TAP_LOOT_PULSE_MS).toBe(1200);
  expect(VISUAL.TAP_LOOT_GLOW).toBeGreaterThan(VISUAL.LOOT_STROKE_WIDTH);

  const moves: Array<[number, number]> = [];
  const ctx = {
    moveTo: (x: number, y: number) => {
      moves.push([x, y]);
    },
    lineTo: (x: number, y: number) => {
      moves.push([x, y]);
    },
    closePath: () => undefined,
  } as unknown as CanvasRenderingContext2D;
  traceTapCanister(ctx, 0, 0, 28);
  expect(moves.length).toBeGreaterThan(1);
  expect(moves.some(([x, y]) => y < -20 && Math.abs(x) < 10)).toBe(true);
  expect(moves.some(([, y]) => y > 15)).toBe(true);
});
