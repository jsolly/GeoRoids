import { afterEach, expect, test, vi } from 'vitest';
import { civicLot } from '../../../shared/furnaces';
import { worldFurnaces } from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawFurnacePipes } from '../../../src/rendering/furnaceRenderer';
import { setWindowViewport } from '../../support/viewport';

afterEach(() => {
  worldFurnaces.replaceLit([]);
  canvasManager.destroy();
  document.querySelector('#gameCanvas')?.remove();
  vi.restoreAllMocks();
});

function recordStrokes(): {
  strokes: Array<{ points: Array<{ x: number; y: number }>; width: number }>;
  restoreViewport: () => void;
} {
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
  return { strokes, restoreViewport };
}

test('a dark street draws no pipeline back to Town Square', () => {
  const street = civicLot('street-1-0');
  if (!street) {
    throw new Error('Missing street lot');
  }
  worldFurnaces.replaceLit([]);
  const recorded = recordStrokes();
  drawFurnacePipes(street.position, 1_000);
  expect(recorded.strokes).toHaveLength(0);
  recorded.restoreViewport();
});

test('a lit street draws a right-angle fire trail toward Town Square', () => {
  const street = civicLot('street-1-0');
  if (!street) {
    throw new Error('Missing street lot');
  }
  worldFurnaces.light(street.id, 'Ada');
  const recorded = recordStrokes();
  drawFurnacePipes(street.position, 1_000);
  const strokes = recorded.strokes;
  expect(strokes).toHaveLength(3);
  const trail = strokes[0];
  if (!trail) {
    throw new Error('Missing fire trail');
  }
  expect(trail.points.length).toBeGreaterThanOrEqual(5);
  expect(trail.points[0]).toEqual({ x: 400, y: 300 });
  const end = trail.points[trail.points.length - 1];
  expect(end?.x).toBeCloseTo(400 - street.position.x, 4);
  expect(end?.y).toBeCloseTo(300 - street.position.y, 4);
  for (const stroke of strokes) {
    const last = stroke.points[stroke.points.length - 1];
    expect(last?.x).toBeCloseTo(400 - street.position.x, 4);
    expect(last?.y).toBeCloseTo(300 - street.position.y, 4);
  }
  let corners = 0;
  for (let index = 1; index < trail.points.length - 1; index += 1) {
    const previous = trail.points[index - 1];
    const point = trail.points[index];
    const next = trail.points[index + 1];
    if (!previous || !point || !next) {
      continue;
    }
    const enteredHorizontally = Math.abs(previous.y - point.y) < 0.001;
    const leftHorizontally = Math.abs(point.y - next.y) < 0.001;
    expect(Math.abs(previous.x - point.x) < 0.001 || Math.abs(previous.y - point.y) < 0.001).toBe(
      true
    );
    if (enteredHorizontally !== leftHorizontally) {
      corners += 1;
    }
  }
  expect(corners).toBeGreaterThanOrEqual(3);
  for (let index = 1; index < trail.points.length; index += 1) {
    const previous = trail.points[index - 1];
    const point = trail.points[index];
    expect(
      Math.abs((previous?.x ?? 0) - (point?.x ?? 0)) < 0.001 ||
        Math.abs((previous?.y ?? 0) - (point?.y ?? 0)) < 0.001
    ).toBe(true);
  }
  recorded.restoreViewport();
});
