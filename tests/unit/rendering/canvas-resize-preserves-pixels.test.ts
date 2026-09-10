import { afterEach, expect, test, vi } from 'vitest';
import { canvasManager } from '../../../src/rendering/canvas';

const pending: FrameRequestCallback[] = [];
let canvas: HTMLCanvasElement | undefined;
afterEach(() => {
  canvasManager.destroy();
  canvas?.remove();
  pending.length = 0;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'requestAnimationFrame');
  Reflect.deleteProperty(window, 'cancelAnimationFrame');
});

test('repeated viewport notifications keep the current picture until dimensions change', () => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    },
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: () => undefined,
  });
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  document.getElementById('gameCanvas')?.remove();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  document.body.append(canvas);
  canvasManager.initialize();
  const context = canvasManager.requireContext();
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 10, 10);
  for (let i = 0; i < 10; i++) {
    window.dispatchEvent(new Event('resize'));
  }
  expect(pending).toHaveLength(1);
  pending.shift()?.(0);
  expect(Array.from(context.getImageData(5, 5, 1, 1).data)).toEqual([255, 0, 0, 255]);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(844);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(390);
  window.dispatchEvent(new Event('resize'));
  pending.shift()?.(1);
  expect(canvas.width).toBe(844);
  expect(canvas.height).toBe(390);
  expect(context.imageSmoothingEnabled).toBe(true);
  expect(context.imageSmoothingQuality).toBe('high');
});
