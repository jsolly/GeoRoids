import { afterEach, expect, test, vi } from 'vitest';
import { getGameBoundary } from '../../../src/physics/boundary';
import { drawFieryBoundary } from '../../../src/rendering/boundaryRenderer';
import { canvasManager } from '../../../src/rendering/canvasSurface';

afterEach(() => {
  canvasManager.destroy();
  vi.restoreAllMocks();
});

test('the arena wall paints when the camera approaches it and skips fully invisible glow', () => {
  canvasManager.initialize();
  canvasManager.clearPlayfield();
  const context = canvasManager.requireContext();
  const canvas = canvasManager.requireCanvas();
  const arc = vi.spyOn(context, 'arc');
  const stroke = vi.spyOn(context, 'stroke');
  const pixels = () => context.getImageData(0, 0, canvas.width, canvas.height).data;
  const background = pixels();

  drawFieryBoundary({ x: 0, y: 0 });
  expect(arc).not.toHaveBeenCalled();
  expect(pixels().every((channel, index) => channel === background[index])).toBe(true);

  const boundaryRadius = getGameBoundary().radius;
  drawFieryBoundary({ x: boundaryRadius - 100, y: 0 });
  expect(arc).toHaveBeenCalledOnce();
  expect(stroke).toHaveBeenCalledOnce();

  canvasManager.clearPlayfield();
  drawFieryBoundary({ x: boundaryRadius - 5000, y: 0 });
  expect(arc).toHaveBeenCalledOnce();
  expect(stroke).toHaveBeenCalledOnce();
  expect(pixels().every((channel, index) => channel === background[index])).toBe(true);
});
