import { afterEach, expect, test, vi } from 'vitest';
import { advanceUtilityFlight, missUtilityFlight } from '../../../shared/utilityFlight';
import { Ship } from '../../../src/entities/ship/Ship';
import { drawHaulerHarpoonRelative } from '../../../src/entities/ship/shipRenderer';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { setWindowViewport } from '../../support/viewport';

let canvas: HTMLCanvasElement | undefined;
let previousCanvas: HTMLElement | null = null;
let restoreViewport = () => {};

afterEach(() => {
  canvasManager.destroy();
  if (previousCanvas) {
    canvas?.replaceWith(previousCanvas);
  } else {
    canvas?.remove();
  }
  previousCanvas = null;
  vi.restoreAllMocks();
  restoreViewport();
});

function scene(kitId: 'hauler' | 'scout') {
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.querySelector('#gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  restoreViewport = setWindowViewport(800, 600);
  canvasManager.initialize();
  const ctx = canvasManager.requireContext();
  const ship = new Ship({ kitId, position: { x: 0, y: 0 } });
  const draw = () => {
    ctx.clearRect(0, 0, 800, 600);
    drawHaulerHarpoonRelative(ship, { x: 0, y: 0 });
  };
  const alpha = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3] ?? 0;
  return { ctx, ship, draw, alpha };
}

test('an outbound tow draws its cable and tip, then the visible tip reels back and disappears', () => {
  const { ctx, ship, draw, alpha } = scene('hauler');
  const lines = vi.spyOn(ctx, 'lineTo');
  const arcs = vi.spyOn(ctx, 'arc');
  ship.utilityFlight = {
    kind: 'tow',
    phase: 'outbound',
    position: { x: 120, y: 0 },
    velocity: { x: 8, y: 0 },
    remainingDistance: 100,
  };
  draw();
  const tip = arcs.mock.calls.at(-1);
  expect(tip).toBeDefined();
  const tipX = tip?.[0] ?? 0;
  expect(tipX).toBeGreaterThan(480);
  expect(tip?.slice(1)).toEqual([300, 3.5, 0, Math.PI * 2]);
  expect(lines.mock.calls).toContainEqual([tipX, 300]);
  expect(alpha(Math.round((400 + tipX) / 2), 300)).toBeGreaterThan(0);
  expect(alpha(Math.round(tipX), 300)).toBe(255);

  missUtilityFlight(ship);
  advanceUtilityFlight(ship);
  arcs.mockClear();
  draw();
  const returningX = arcs.mock.calls.at(-1)?.[0] ?? 0;
  expect(returningX).toBeGreaterThan(400);
  expect(returningX).toBeLessThan(tipX);
  expect(alpha(Math.round(returningX), 300)).toBe(255);
  expect(alpha(Math.round(tipX), 300)).toBe(0);
  for (let frame = 0; frame < 20; frame++) {
    advanceUtilityFlight(ship);
  }
  expect(ship.utilityFlight).toBeNull();
  lines.mockClear();
  arcs.mockClear();
  draw();
  expect(lines).not.toHaveBeenCalled();
  expect(arcs).not.toHaveBeenCalled();
  expect(alpha(Math.round(returningX), 300)).toBe(0);
});

test('a flying probe draws a bright diamond, expands into fading dust on a miss and leaves no pixels', () => {
  const { ctx, ship, draw, alpha } = scene('scout');
  const lines = vi.spyOn(ctx, 'lineTo');
  const arcs = vi.spyOn(ctx, 'arc');
  ship.utilityFlight = {
    kind: 'probe',
    phase: 'outbound',
    position: { x: 120, y: 0 },
    velocity: { x: 10, y: 0 },
    remainingDistance: 100,
  };
  draw();
  const tipX = lines.mock.calls[1]?.[0] ?? 0;
  expect(tipX).toBeGreaterThan(480);
  expect(lines.mock.calls).toEqual([
    [tipX + 5, 300],
    [tipX, 305],
    [tipX - 5, 300],
  ]);
  expect(alpha(Math.round(tipX), 300)).toBe(255);
  missUtilityFlight(ship);
  arcs.mockClear();
  draw();
  expect(arcs).toHaveBeenCalledTimes(8);
  expect(arcs.mock.calls[0]).toEqual([tipX + 3, 300, 1.5, 0, Math.PI * 2]);
  const earlyAlpha = alpha(Math.round(tipX + 3), 300);
  expect(earlyAlpha).toBeGreaterThan(200);

  for (let frame = 0; frame < 12; frame++) {
    advanceUtilityFlight(ship);
  }
  arcs.mockClear();
  draw();
  expect(arcs).toHaveBeenCalledTimes(8);
  expect(arcs.mock.calls[0]).toEqual([tipX + 14, 300, 1.5, 0, Math.PI * 2]);
  const fadedAlpha = alpha(Math.round(tipX + 14), 300);
  expect(fadedAlpha).toBeGreaterThan(0);
  expect(fadedAlpha).toBeLessThan(earlyAlpha);
  expect(alpha(Math.round(tipX + 3), 300)).toBe(0);
  for (let frame = 0; frame < 12; frame++) {
    advanceUtilityFlight(ship);
  }
  expect(ship.utilityFlight).toBeNull();
  arcs.mockClear();
  lines.mockClear();
  draw();
  expect(arcs).not.toHaveBeenCalled();
  expect(lines).not.toHaveBeenCalled();
  expect(alpha(Math.round(tipX + 14), 300)).toBe(0);
});
