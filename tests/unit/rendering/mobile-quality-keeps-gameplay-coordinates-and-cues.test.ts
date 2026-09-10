import { afterEach, expect, test, vi } from 'vitest';
import { canvasManager } from '../../../src/rendering/canvas';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import { strokePhosphorPolyline } from '../../../src/rendering/vectorJuice';

const originalUrl = window.location.href;
const originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

afterEach(() => {
  canvasManager.destroy();
  window.history.replaceState(null, '', originalUrl);
  if (originalDpr) {
    Object.defineProperty(window, 'devicePixelRatio', originalDpr);
  }
  vi.restoreAllMocks();
});

test('a DPR-three pilot keeps the same view and aiming coordinates at lower rendering resolution', () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
  window.history.replaceState(null, '', '?performance=collect&renderDpr=1.5&renderGlow=off');
  canvasManager.initialize();
  const viewport = canvasManager.getViewportSize();
  const canvas = canvasManager.requireCanvas();
  expect(canvas.width).toBe(Math.round(viewport.width * 1.5));
  expect(canvas.height).toBe(Math.round(viewport.height * 1.5));
  expect(canvasManager.requireContext().getTransform().a).toBe(1.5);
  const position = { x: 120, y: 240 };
  const screen = canvasManager.worldToScreen(position, position);
  expect(screen.x).toBe(viewport.width / 2);
  expect(screen.y).toBe(viewport.height / 2);
  expect(canvasManager.screenToWorld(screen, position)).toEqual(position);

  canvasManager.destroy();
  window.history.replaceState(null, '', '?performance=collect&renderDpr=native');
  canvasManager.initialize();
  expect(canvas.width).toBe(Math.round(viewport.width * 3));
  expect(canvasManager.worldToScreen(position, position)).toEqual(screen);
});

test('diagnostic rendering caps never increase a lower-density display backing store', () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 });
  window.history.replaceState(null, '', '?performance=1&renderDpr=2');
  canvasManager.initialize();
  expect(canvasManager.requireContext().getTransform().a).toBe(1.25);
  expect(canvasManager.requireCanvas().width).toBe(
    Math.round(canvasManager.getViewportSize().width * 1.25)
  );
});

test('ordinary touch play keeps full quality and rejects invalid experiments only in diagnostic mode', () => {
  expect(configureRenderQuality('?renderDpr=1.5&renderGlow=off', true)).toEqual({
    maxDpr: 'native',
    glow: 'full',
    source: 'touch-default',
  });
  expect(() => configureRenderQuality('?performance=collect&renderDpr=0', true)).toThrow(
    'renderDpr'
  );
  expect(() => configureRenderQuality('?performance=1&renderGlow=dim', true)).toThrow('renderGlow');
});

test('turning off glow retains every phosphor hull stroke and vertex', () => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  const points = [
    { x: 10, y: 10 },
    { x: 25, y: 40 },
    { x: 40, y: 10 },
  ];
  const blurAtStroke: number[] = [];
  const nativeStroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    blurAtStroke.push(ctx.shadowBlur);
    nativeStroke();
  });
  const move = vi.spyOn(ctx, 'moveTo');
  const line = vi.spyOn(ctx, 'lineTo');
  configureRenderQuality('?performance=collect&renderGlow=full', true);
  strokePhosphorPolyline(ctx, points, '#ffffff', 2, 8, true);
  const full = { moves: [...move.mock.calls], lines: [...line.mock.calls] };
  expect(blurAtStroke).toEqual([8, 0]);
  move.mockClear();
  line.mockClear();
  blurAtStroke.length = 0;

  configureRenderQuality('?performance=collect&renderGlow=off', true);
  strokePhosphorPolyline(ctx, points, '#ffffff', 2, 8, true);
  expect(blurAtStroke).toEqual([0, 0]);
  expect({ moves: move.mock.calls, lines: line.mock.calls }).toEqual(full);
  expect(full.lines).toEqual([
    [25, 40],
    [40, 10],
    [25, 40],
    [40, 10],
  ]);
});
