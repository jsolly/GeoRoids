import { afterEach, expect, test, vi } from 'vitest';
import { drawFieryBoundary } from '../../../src/rendering/boundaryRenderer';
import { canvasManager } from '../../../src/rendering/canvas';

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
  const pixels = () => context.getImageData(0, 0, canvas.width, canvas.height).data;
  const background = pixels();

  drawFieryBoundary({ x: 0, y: 0 });
  expect(arc).not.toHaveBeenCalled();
  expect(pixels().every((channel, index) => channel === background[index])).toBe(true);

  drawFieryBoundary({ x: 2800, y: 0 });
  expect(arc).toHaveBeenCalledOnce();
  expect(pixels().some((channel, index) => channel !== background[index])).toBe(true);

  canvasManager.clearPlayfield();
  drawFieryBoundary({ x: 5000, y: 0 });
  expect(arc).toHaveBeenCalledOnce();
  expect(pixels().every((channel, index) => channel === background[index])).toBe(true);
});
