/* @vitest-environment node */
import { createCanvas } from 'canvas';
import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, VISUAL } from '../../../src/constants';
import { drawSatelliteHealth } from '../../../src/entities/satellitePickup/satelliteHealthRenderer';

afterEach(() => vi.restoreAllMocks());

test('a damaged deployed satellite shows a ship-style health bar proportional to its health', () => {
  const ctx = createCanvas(100, 100).getContext('2d');
  const line = vi.spyOn(ctx, 'lineTo');
  const arc = vi.spyOn(ctx, 'arc');
  const strokes: Array<{ width: number; color: unknown; glow: number }> = [];
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push({ width: ctx.lineWidth, color: ctx.strokeStyle, glow: ctx.shadowBlur });
  });
  drawSatelliteHealth(ctx, { state: 'orbiting', health: 25, maxHealth: 50 }, { x: 50, y: 50 }, 10);
  expect(line.mock.calls).toEqual([
    [62, 30],
    [50, 30],
  ]);
  expect(strokes[1]).toEqual({
    width: VISUAL.HEALTH_CAPSULE_HEIGHT,
    color: PALETTE.HEALTH.toLowerCase(),
    glow: 0,
  });
  expect(arc).not.toHaveBeenCalled();
});

test('full-health and undeployed satellites have no health overlay', () => {
  const ctx = createCanvas(100, 100).getContext('2d');
  const stroke = vi.spyOn(ctx, 'stroke');
  for (const state of ['loose', 'stored', 'broken'] as const) {
    drawSatelliteHealth(ctx, { state, health: 25, maxHealth: 50 }, { x: 50, y: 50 }, 12);
  }
  drawSatelliteHealth(ctx, { state: 'orbiting', health: 50, maxHealth: 50 }, { x: 50, y: 50 }, 12);
  expect(stroke).not.toHaveBeenCalled();
});
