import { afterEach, beforeEach, expect, test } from 'vitest';

import { canvasManager } from '../../../src/rendering/canvas';
import { projectWorldToScreenInto } from '../../../src/rendering/playfieldCamera';

let canvas: HTMLCanvasElement | undefined;
let previousCanvas: HTMLElement | null = null;

beforeEach(() => canvasManager.destroy());
afterEach(() => {
  canvasManager.destroy();
  if (previousCanvas) {
    canvas?.replaceWith(previousCanvas);
  } else {
    canvas?.remove();
  }
  canvas = undefined;
  previousCanvas = null;
});

test.each([
  { width: 1920, height: 1080, center: { x: 960, y: 540 }, target: { x: 1030, y: 500 } },
  { width: 390, height: 844, center: { x: 195, y: 422 }, target: { x: 265, y: 382 } },
])('a $width × $height playfield centers the ship and reverses its world projection', ({
  width,
  height,
  center,
  target,
}) => {
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.getElementById('gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  canvasManager.initialize();
  canvas.width = width;
  canvas.height = height;
  const ship = { x: -200, y: 300 };
  const world = { x: -130, y: 260 };
  const out = { x: 0, y: 0 };

  expect(canvasManager.worldToScreen(ship, ship)).toMatchObject(center);
  expect(canvasManager.worldToScreenInto(out, world, ship)).toBe(out);
  expect(out).toEqual(target);
  const screen = canvasManager.worldToScreen(world, ship);
  expect(screen).toMatchObject(target);
  expect(canvasManager.screenToWorld(screen, ship)).toEqual(world);
});

test('before canvas initialization, ship-relative coordinates still round-trip without a viewport offset', () => {
  const world = { x: 10, y: 20 };
  const ship = { x: 3, y: 4 };
  const out = { x: 1, y: 2 };
  expect(canvasManager.worldToScreenInto(out, world, ship)).toBe(out);
  expect(out).toEqual({ x: 7, y: 16 });
  const screen = canvasManager.worldToScreen(world, ship);
  expect(screen).toMatchObject(out);
  expect(canvasManager.screenToWorld(screen, ship)).toEqual(world);
});

test('generic projection retains explicit distant-view scales and reuses its destination', () => {
  const out = { x: 0, y: 0 };
  const world = { x: 20, y: 10 };
  const ship = { x: 4, y: 2 };
  const viewport = { width: 200, height: 100 };
  expect(projectWorldToScreenInto(out, world, ship, viewport)).toBe(out);
  expect(out).toEqual({ x: 116, y: 58 });
  expect(projectWorldToScreenInto(out, world, ship, viewport, 0.25)).toBe(out);
  expect(out).toEqual({ x: 104, y: 52 });
  expect(projectWorldToScreenInto(out, world, ship, viewport, 0.1)).toBe(out);
  expect(out).toEqual({ x: 101.6, y: 50.8 });
});
