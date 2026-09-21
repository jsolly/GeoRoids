import { afterEach, expect, test, vi } from 'vitest';
import { civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import {
  activeFurnacePipePulses,
  FURNACE_PIPE_FADE_MS,
  furnacePipeFrame,
  noteFurnacePipePulse,
  resetFurnacePipePulses,
} from '../../../src/fx/furnacePipePulse';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawFurnacePipes } from '../../../src/rendering/furnaceRenderer';
import { setWindowViewport } from '../../support/viewport';

afterEach(() => {
  resetFurnacePipePulses();
  canvasManager.destroy();
  document.querySelector('#gameCanvas')?.remove();
  vi.restoreAllMocks();
});

test('a street delivery lights the whole pipe and the head runs to Town Square', () => {
  const street = civicLot('street-1-0');
  if (!street) {
    throw new Error('Missing East Street');
  }
  expect(noteFurnacePipePulse(TOWN_HEARTH.id, 0)).toBe(false);
  expect(noteFurnacePipePulse(street.id, 1_000)).toBe(true);
  const pulse = activeFurnacePipePulses(1_000)[0];
  if (!pulse) {
    throw new Error('Missing pipe pulse');
  }
  expect(furnacePipeFrame(pulse, 1_000)?.head).toEqual(street.position);
  const midway = furnacePipeFrame(pulse, 1_000 + pulse.travelMs / 2)?.head;
  if (!midway) {
    throw new Error('Missing midway head');
  }
  expect(midway.x).toBeCloseTo(street.position.x / 2, 5);
  expect(midway.y).toBeCloseTo(street.position.y / 2, 5);
  expect(furnacePipeFrame(pulse, 1_000 + pulse.travelMs)?.head).toEqual(TOWN_HEARTH.position);
  expect(furnacePipeFrame(pulse, 1_000 + pulse.travelMs + FURNACE_PIPE_FADE_MS)).toMatchObject({
    alpha: 0,
    head: TOWN_HEARTH.position,
  });
  expect(
    furnacePipeFrame(pulse, 1_000 + pulse.travelMs + FURNACE_PIPE_FADE_MS + 1)
  ).toBeUndefined();

  const restoreViewport = setWindowViewport(800, 600);
  const canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  document.body.append(canvas);
  canvasManager.initialize();
  const ctx = canvasManager.requireContext();
  const strokes: Array<{ points: Array<{ x: number; y: number }>; width: number }> = [];
  let points: Array<{ x: number; y: number }> = [];
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push({ x, y });
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    points.push({ x, y });
  });
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push({ points: [...points], width: ctx.lineWidth });
  });
  drawFurnacePipes(street.position, 1_000);
  const lit = strokes.find((stroke) => stroke.width === 3);
  expect(lit?.points[0]).toEqual({ x: 400, y: 300 });
  expect(lit?.points[1]).toEqual({
    x: 400 - street.position.x,
    y: 300 - street.position.y,
  });
  restoreViewport();
});
