import { expect, test, vi } from 'vitest';
import {
  drawRoidInteractionCues,
  reflectiveFacetCueCount,
} from '../../../src/entities/roid/roidRenderer';

function context(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    translate: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

test('reflective cue count grows within a bounded three-facet range', () => {
  expect(reflectiveFacetCueCount(0, 9)).toBe(1);
  expect(reflectiveFacetCueCount(4, 9)).toBe(2);
  expect(reflectiveFacetCueCount(9, 9)).toBe(3);
  expect(reflectiveFacetCueCount(100, 0)).toBe(1);
});

test('reflective and spin cues draw sparse screen-space strokes', () => {
  const ctx = context();
  drawRoidInteractionCues(
    ctx,
    {
      phenomenon: { kind: 'reflective', clusterId: 'cluster-1', energy: 5, maxEnergy: 10 },
      spinClass: 'charged',
    },
    20,
    125,
    240
  );

  expect(ctx.save).toHaveBeenCalledOnce();
  expect(ctx.translate).toHaveBeenCalledWith(125, 240);
  expect(ctx.restore).toHaveBeenCalledOnce();
  expect(ctx.stroke).toHaveBeenCalled();
  expect(ctx.fill).toBeUndefined();
});

test('rocks without retained reflection or spin metadata remain visually silent', () => {
  const ctx = context();
  drawRoidInteractionCues(ctx, {}, 20);
  expect(ctx.save).not.toHaveBeenCalled();
  expect(ctx.stroke).not.toHaveBeenCalled();
});
