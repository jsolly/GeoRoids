import { afterEach, expect, test, vi } from 'vitest';
import {
  drawQuakePulseRelative,
  startQuakePulse,
} from '../../../src/entities/ship/quakePulseRenderer';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvas';

afterEach(() => vi.restoreAllMocks());

test('the pulse stays at its origin after the moving ship finishes its instantaneous ability', () => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );
  const arc = vi.spyOn(ctx, 'arc');
  const ship = { kitId: 'quake', position: { x: 50, y: 70 }, abilityActiveFrames: 18 };
  startQuakePulse(ship, ship.position, 0, 1000);
  ship.position.x = 150;
  ship.abilityActiveFrames = 0;
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 1400);
  expect(arc.mock.calls[0]?.slice(0, 2)).toEqual([50, 70]);
  expect(arc.mock.calls[0]?.[2]).toBeGreaterThan(150);
  // A delayed snapshot must not restart the same ring when its timer briefly rises.
  ship.abilityActiveFrames = 1;
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 1450);
  arc.mockClear();
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 1660);
  expect(arc).not.toHaveBeenCalled();
  ship.abilityActiveFrames = 0;
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 2000);
  ship.abilityActiveFrames = 18;
  startQuakePulse(ship, ship.position, 0, 3000);
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 3100);
  expect(arc.mock.calls[0]?.slice(0, 2)).toEqual([150, 70]);
});

test('a remote event preserves its origin and elapsed phase before the first render', () => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context unavailable');
  }
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (position) => new Point(position.x, position.y)
  );
  const arc = vi.spyOn(ctx, 'arc');
  const ship = { kitId: 'quake', position: { x: 900, y: 900 } };
  startQuakePulse(ship, { x: 20, y: 30 }, 100, 1000);
  ship.position.x = 1000;
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 1200);
  expect(arc.mock.calls[0]?.slice(0, 2)).toEqual([20, 30]);
  expect(arc.mock.calls[0]?.[2]).toBeCloseTo(200 * (1 - (1 - 300 / 650) ** 2));
  // The server echo corrects a predicted origin without starting a second wave.
  startQuakePulse(ship, { x: 25, y: 35 }, 0, 1250);
  arc.mockClear();
  drawQuakePulseRelative(ship, { x: 0, y: 0 }, 1551);
  expect(arc).not.toHaveBeenCalled();
});
