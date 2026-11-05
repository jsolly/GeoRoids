import { afterEach, expect, test, vi } from 'vitest';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import {
  configureRenderQuality,
  qualityAudience,
  resolveGlow,
} from '../../../src/rendering/renderQuality';
import { strokePhosphorPolyline } from '../../../src/rendering/vectorJuice';
import { shouldUseTouchControls } from '../../../src/ui/viewportChrome';

const originalUrl = window.location.href;
const originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

afterEach(() => {
  canvasManager.destroy();
  window.history.replaceState(null, '', originalUrl);
  if (originalDpr) {
    Object.defineProperty(window, 'devicePixelRatio', originalDpr);
  }
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'deviceMemory');
});

test('a DPR-three pilot keeps the same view and aiming coordinates at lower rendering resolution', () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
  window.history.replaceState(null, '', '?performance=collect&renderDpr=1.5&renderGlow=off');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  const viewport = canvasManager.getViewportSize();
  const canvas = canvasManager.requireCanvas();
  expect(canvas.width).toBe(Math.round(viewport.width * 1.5));
  expect(canvas.height).toBe(Math.round(viewport.height * 1.5));
  expect(canvasManager.requireContext().getTransform().a).toBe(1.5);
  const position = { x: 120, y: 240 };
  const screen = canvasManager.worldToScreen(position, position);
  expect(screen.x).toBe(viewport.width / 2);
  expect(screen.y).toBe(viewport.height / 2);

  canvasManager.destroy();
  window.history.replaceState(null, '', '?performance=collect&renderDpr=native');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(canvas.width).toBe(Math.round(viewport.width * 3));
  expect(canvasManager.worldToScreen(position, position)).toEqual(screen);
});

test('diagnostic rendering caps never increase a lower-density display backing store', () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 });
  window.history.replaceState(null, '', '?performance=1&renderDpr=2');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(canvasManager.requireContext().getTransform().a).toBe(1.25);
  expect(canvasManager.requireCanvas().width).toBe(
    Math.round(canvasManager.getViewportSize().width * 1.25)
  );
});

test.each([
  ['1', 1],
  ['0.75', 0.75],
] as const)(
  'a DPR-1.5 tablet can lower backing resolution to %s while keeping its view',
  (cap, effectiveDpr) => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 });
    window.history.replaceState(null, '', '?performance=collect&renderDpr=native');
    canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
    const position = { x: 2240, y: 3545 };
    const target = { x: 2310, y: 3505 };
    const viewport = { ...canvasManager.getViewportSize() };
    const screen = canvasManager.worldToScreen(position, target);
    canvasManager.destroy();

    window.history.replaceState(null, '', `?performance=collect&renderDpr=${cap}`);
    canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
    expect(canvasManager.getViewportSize()).toEqual(viewport);
    expect(canvasManager.requireCanvas().width).toBe(Math.round(viewport.width * effectiveDpr));
    expect(canvasManager.requireCanvas().height).toBe(Math.round(viewport.height * effectiveDpr));
    expect(canvasManager.requireContext().getTransform().a).toBe(effectiveDpr);
    expect(canvasManager.worldToScreen(position, target)).toEqual(screen);
  }
);

test('ordinary touch play keeps full quality and rejects invalid experiments only in diagnostic mode', () => {
  expect(configureRenderQuality('?renderDpr=1.5&renderGlow=off', 'touch')).toEqual({
    maxDpr: 'native',
    glow: 'full',
    source: 'touch-default',
  });
  expect(() => configureRenderQuality('?performance=collect&renderDpr=0', 'touch')).toThrow(
    'renderDpr'
  );
  expect(() => configureRenderQuality('?performance=1&renderGlow=dim', 'touch')).toThrow(
    'renderGlow'
  );
});

const fireTablet =
  'Mozilla/5.0 (Linux; Android 11; KFTUWI) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.158 Safari/537.36';
const androidTablet =
  'Mozilla/5.0 (Linux; Android 12; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** A touch tablet: coarse pointer, so the game shows touch controls, with the given hardware hints. */
function joinOnTouchTablet(userAgent: string, deviceMemory: number, cores: number): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(cores);
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: deviceMemory });
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      Object.assign(new window.EventTarget(), {
        matches: query === '(pointer: coarse)' || query === '(hover: none)',
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
      }) as unknown as MediaQueryList
  );
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(shouldUseTouchControls()).toBe(true);
}

test.each([
  ['the measured Fire tablet', fireTablet, 2, 8],
  ['a 4 GB four-core touch tablet', androidTablet, 4, 4],
])('%s flies its touch controls without glow by default', (_device, userAgent, memory, cores) => {
  window.history.replaceState(null, '', '/');
  joinOnTouchTablet(userAgent, memory, cores);
  expect(canvasManager.getDeviceCategory()).toBe('low-end');
  expect(resolveGlow(8)).toBe(0);
});

test('a capable touch tablet and a desktop keep full glow', () => {
  window.history.replaceState(null, '', '/');
  joinOnTouchTablet(androidTablet, 8, 8);
  expect(canvasManager.getDeviceCategory()).not.toBe('low-end');
  expect(resolveGlow(8)).toBe(8);
  canvasManager.destroy();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'deviceMemory');

  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/155.0.0.0 Safari/537.36'
  );
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(shouldUseTouchControls()).toBe(false);
  expect(resolveGlow(8)).toBe(8);
});

test('a low-end device keeps its low-end preset whatever controls it shows', () => {
  expect(qualityAudience('low-end', true)).toBe('low-end');
  expect(qualityAudience('low-end', false)).toBe('low-end');
  expect(qualityAudience('commodity', true)).toBe('touch');
  expect(qualityAudience('unknown', false)).toBe('desktop');
});

test('a low-end touch pilot can still compare full glow in a diagnostic visit', () => {
  window.history.replaceState(null, '', '?performance=collect&renderGlow=full');
  joinOnTouchTablet(fireTablet, 2, 8);
  expect(canvasManager.getDeviceCategory()).toBe('low-end');
  expect(resolveGlow(8)).toBe(8);
  expect(configureRenderQuality('', qualityAudience('low-end', true))).toEqual({
    maxDpr: 'native',
    glow: 'off',
    source: 'low-end-default',
  });
  expect(configureRenderQuality('?performance=1&renderGlow=full', 'low-end')).toEqual({
    maxDpr: 'native',
    glow: 'full',
    source: 'diagnostic',
  });
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
  configureRenderQuality('?performance=collect&renderGlow=full', 'touch');
  strokePhosphorPolyline(ctx, points, '#ffffff', 2, 8, true);
  const full = { moves: [...move.mock.calls], lines: [...line.mock.calls] };
  expect(blurAtStroke).toEqual([8, 0]);
  move.mockClear();
  line.mockClear();
  blurAtStroke.length = 0;

  configureRenderQuality('?performance=collect&renderGlow=off', 'touch');
  strokePhosphorPolyline(ctx, points, '#ffffff', 2, 8, true);
  expect(blurAtStroke).toEqual([0, 0]);
  expect({ moves: move.mock.calls, lines: line.mock.calls }).toEqual(full);
  expect(full.lines).toEqual([
    [25, 40],
    [40, 10],
  ]);
});
