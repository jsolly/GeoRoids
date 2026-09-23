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

test('a furnace delivery lights the whole pipe and the head runs to Town Square', () => {
  const furnace = civicLot('street-1-0');
  if (!furnace) {
    throw new Error('Missing East Furnace');
  }
  expect(noteFurnacePipePulse(TOWN_HEARTH.id, 0)).toBe(false);
  expect(noteFurnacePipePulse(furnace.id, 1_000)).toBe(true);
  const pulse = activeFurnacePipePulses(1_000)[0];
  if (!pulse) {
    throw new Error('Missing pipe pulse');
  }
  expect(furnacePipeFrame(pulse, 1_000)?.head).toEqual(furnace.position);
  expect(pulse.points.length).toBeGreaterThan(2);
  const midway = furnacePipeFrame(pulse, 1_000 + pulse.travelMs / 2)?.head;
  if (!midway) {
    throw new Error('Missing midway head');
  }
  let length = 0;
  for (let index = 1; index < pulse.points.length; index += 1) {
    const start = pulse.points[index - 1];
    const end = pulse.points[index];
    if (start && end) {
      length += Math.hypot(end.x - start.x, end.y - start.y);
    }
  }
  let remaining = length / 2;
  let expected = pulse.points[0] ?? furnace.position;
  for (let index = 1; index < pulse.points.length; index += 1) {
    const start = pulse.points[index - 1];
    const end = pulse.points[index];
    if (!start || !end) {
      continue;
    }
    const span = Math.hypot(end.x - start.x, end.y - start.y);
    if (remaining <= span || index === pulse.points.length - 1) {
      const t = span === 0 ? 1 : Math.min(1, remaining / span);
      expected = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      break;
    }
    remaining -= span;
  }
  expect(midway.x).toBeCloseTo(expected.x, 4);
  expect(midway.y).toBeCloseTo(expected.y, 4);
  const chordOffset = Math.max(
    ...pulse.points.map((point) => {
      const abx = -furnace.position.x;
      const aby = -furnace.position.y;
      const lengthSquared = abx * abx + aby * aby;
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((point.x - furnace.position.x) * abx + (point.y - furnace.position.y) * aby) /
                  lengthSquared
              )
            );
      return Math.hypot(
        point.x - (furnace.position.x + abx * t),
        point.y - (furnace.position.y + aby * t)
      );
    })
  );
  expect(chordOffset).toBeGreaterThan(40);
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
  drawFurnacePipes(furnace.position, 1_000);
  const lit = strokes.find((stroke) => stroke.width === 3);
  expect(lit?.points[0]).toEqual({ x: 400, y: 300 });
  expect(lit?.points[lit.points.length - 1]).toEqual({
    x: 400 - furnace.position.x,
    y: 300 - furnace.position.y,
  });
  expect(lit?.points.length).toBe(pulse.points.length);
  for (let index = 1; index < (lit?.points.length ?? 0); index += 1) {
    const start = lit?.points[index - 1];
    const end = lit?.points[index];
    expect(
      start && end && (Math.abs(start.x - end.x) < 0.001 || Math.abs(start.y - end.y) < 0.001)
    ).toBe(true);
  }
  restoreViewport();
});
