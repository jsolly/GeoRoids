import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { harpoonLatchRange } from '../../../src/entities/ship/shipAbilities';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { handleMouseMove } from '../../../src/input/mouse';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvas';
import { PLAYFIELD_CLOSE_SCALE } from '../../../src/rendering/playfieldCamera';

let canvas: HTMLCanvasElement;
let originalInnerWidth: PropertyDescriptor | undefined;
let originalInnerHeight: PropertyDescriptor | undefined;
let originalDevicePixelRatio: PropertyDescriptor | undefined;
let originalRect: (() => DOMRect) | undefined;
let originalMatchMedia: typeof window.matchMedia;
let mediaQueries: ControlledMediaQuery[] = [];

type ControlledMediaQuery = MediaQueryList & {
  emitChange: () => void;
  listenerCount: () => number;
};

function setWindowValue(
  name: 'innerWidth' | 'innerHeight' | 'devicePixelRatio',
  value: number
): void {
  Object.defineProperty(window, name, {
    configurable: true,
    value,
    writable: true,
  });
}

function restoreWindowValue(
  name: 'innerWidth' | 'innerHeight' | 'devicePixelRatio',
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(window, name, descriptor);
  } else {
    Reflect.deleteProperty(window, name);
  }
}

function installControlledMatchMedia(): void {
  originalMatchMedia = window.matchMedia;
  mediaQueries = [];
  window.matchMedia = ((query: string): MediaQueryList => {
    const listeners = new Set<EventListener>();
    const addEventListener = (
      _type: string,
      listener: EventListenerOrEventListenerObject | null
    ): void => {
      if (typeof listener === 'function') {
        listeners.add(listener);
      }
    };
    const removeEventListener = (
      _type: string,
      listener: EventListenerOrEventListenerObject | null
    ): void => {
      if (typeof listener === 'function') {
        listeners.delete(listener);
      }
    };
    const mediaQuery = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener,
      dispatchEvent(event: Event): boolean {
        for (const listener of listeners) {
          listener(event);
        }
        return true;
      },
    } as unknown as ControlledMediaQuery;
    mediaQuery.emitChange = (): void => {
      mediaQuery.dispatchEvent(new Event('change'));
    };
    mediaQuery.listenerCount = (): number => listeners.size;
    mediaQueries.push(mediaQuery);
    return mediaQuery;
  }) as typeof window.matchMedia;
}

beforeEach(() => {
  canvasManager.destroy();
  const element = document.getElementById('gameCanvas');
  if (element?.tagName !== 'CANVAS') {
    throw new Error('expected the playfield canvas in the test shell');
  }
  canvas = element as HTMLCanvasElement;
  originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  originalRect = canvas.getBoundingClientRect;
  installControlledMatchMedia();
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.width = '';
  canvas.style.height = '';
  setWindowValue('innerWidth', 1200);
  setWindowValue('innerHeight', 900);
  setWindowValue('devicePixelRatio', 2);

  canvasManager.initialize();
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1200,
      height: 900,
      right: 1200,
      bottom: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterEach(() => {
  canvasManager.destroy();
  if (canvas && originalRect) {
    canvas.getBoundingClientRect = originalRect;
  }
  restoreWindowValue('innerWidth', originalInnerWidth);
  restoreWindowValue('innerHeight', originalInnerHeight);
  restoreWindowValue('devicePixelRatio', originalDevicePixelRatio);
  window.matchMedia = originalMatchMedia;
});

describe('the playfield viewport stays in CSS-logical coordinates', () => {
  test('high-DPI backing pixels do not change projection, aiming, or latch reach', () => {
    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(1800);
    expect(canvas.style.width).toBe('1200px');
    expect(canvas.style.height).toBe('900px');
    expect(canvasManager.getViewportSize()).toEqual({ width: 1200, height: 900 });

    const transform = canvasManager.requireContext().getTransform();
    expect(transform.a).toBe(2);
    expect(transform.d).toBe(2);

    const shipPosition = { x: 120, y: -80 };
    expect(canvasManager.worldToScreen({ ...shipPosition }, shipPosition)).toEqual(
      new Point(600, 450)
    );
    expect(canvasManager.screenToWorld(new Point(650, 400), shipPosition)).toEqual({
      x: 170,
      y: -130,
    });

    const player = new Player({
      id: 'dpr-aim',
      name: 'DPR Aim',
      type: 'local',
      input: new MockPlayerInput(),
    });
    handleMouseMove(new MouseEvent('mousemove', { clientX: 650, clientY: 300 }), player);
    expect(player.ship.angle).toBeCloseTo(Math.atan2(150, 50), 10);

    expect(harpoonLatchRange(PLAYFIELD_CLOSE_SCALE, canvasManager.getViewportSize())).toBe(750);
  });

  test('same-size resize and same-DOM reinitialization preserve the high-DPI contract', () => {
    const context = canvasManager.requireContext();
    context.fillStyle = '#ff0000';
    context.fillRect(1, 1, 1, 1);
    const beforeResize = context.getImageData(2, 2, 1, 1).data;

    window.dispatchEvent(new Event('resize'));

    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(1800);
    expect(Array.from(context.getImageData(2, 2, 1, 1).data)).toEqual(Array.from(beforeResize));

    canvasManager.destroy();
    canvasManager.initialize();

    expect(canvasManager.getViewportSize()).toEqual({ width: 1200, height: 900 });
    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(1800);
    const transform = canvasManager.requireContext().getTransform();
    expect(transform.a).toBe(2);
    expect(transform.d).toBe(2);
  });

  test('rebinds on repeated DPR-only changes and tears down across reinitialization', () => {
    expect(mediaQueries.map((query) => query.media)).toEqual(['(resolution: 2dppx)']);

    const initialQuery = mediaQueries[0];
    setWindowValue('devicePixelRatio', 1.5);
    initialQuery?.emitChange();

    expect(canvasManager.getViewportSize()).toEqual({ width: 1200, height: 900 });
    expect(canvas.width).toBe(1800);
    expect(canvas.height).toBe(1350);
    expect(canvasManager.requireContext().getTransform().a).toBe(1.5);
    expect(initialQuery?.listenerCount()).toBe(0);
    expect(mediaQueries.map((query) => query.media)).toEqual([
      '(resolution: 2dppx)',
      '(resolution: 1.5dppx)',
    ]);

    const secondQuery = mediaQueries[1];
    setWindowValue('devicePixelRatio', 2.25);
    secondQuery?.emitChange();

    expect(canvasManager.getViewportSize()).toEqual({ width: 1200, height: 900 });
    expect(canvas.width).toBe(2700);
    expect(canvas.height).toBe(2025);
    expect(canvasManager.requireContext().getTransform().a).toBe(2.25);
    expect(secondQuery?.listenerCount()).toBe(0);
    expect(mediaQueries.at(-1)?.media).toBe('(resolution: 2.25dppx)');

    const lastQueryBeforeDestroy = mediaQueries.at(-1);
    canvasManager.destroy();
    expect(lastQueryBeforeDestroy?.listenerCount()).toBe(0);

    setWindowValue('devicePixelRatio', 1.25);
    lastQueryBeforeDestroy?.emitChange();
    expect(canvas.width).toBe(2700);
    expect(canvas.height).toBe(2025);

    canvasManager.initialize();

    expect(canvasManager.getViewportSize()).toEqual({ width: 1200, height: 900 });
    expect(canvas.width).toBe(1500);
    expect(canvas.height).toBe(1125);
    expect(canvasManager.requireContext().getTransform().a).toBe(1.25);
    expect(mediaQueries.at(-1)?.media).toBe('(resolution: 1.25dppx)');
  });
});
