import { expect, test, vi } from 'vitest';
import type { AsteroidMaterial } from '../../../shared-types';
import { asteroidMapInk, drawResourceMapMark } from '../../../src/rendering/hud/resourceMapMark';

test('scanned minerals keep the same rock outline while their ink and surface cuts differ', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Map requires a canvas');
  }
  const line = vi.spyOn(ctx, 'lineTo');
  const move = vi.spyOn(ctx, 'moveTo');
  const outlines: number[][][] = [];
  const surfaces: number[][][] = [];
  const colors = new Set<string>();
  const minerals: AsteroidMaterial[] = ['ice', 'metal', 'rubble'];
  for (const mineral of minerals) {
    line.mockClear();
    move.mockClear();
    ctx.strokeStyle = '#123456';
    ctx.lineWidth = 7;
    drawResourceMapMark(ctx, 'asteroid', 20, 20, 5, asteroidMapInk(mineral), mineral);
    outlines.push(line.mock.calls.slice(0, 7));
    surfaces.push(line.mock.calls.slice(7));
    colors.add(asteroidMapInk(mineral));
    expect(move.mock.calls[0]).toEqual([15.25, 18.75]);
    expect(line.mock.calls.slice(0, 7)).toHaveLength(7);
    expect(ctx.strokeStyle).toBe('#123456');
    expect(ctx.lineWidth).toBe(7);
  }
  expect(outlines[0]).toEqual(outlines[1]);
  expect(outlines[1]).toEqual(outlines[2]);
  expect(surfaces[0]).not.toEqual(surfaces[1]);
  expect(surfaces[1]).not.toEqual(surfaces[2]);
  expect(colors.size).toBe(3);
  vi.restoreAllMocks();
});
