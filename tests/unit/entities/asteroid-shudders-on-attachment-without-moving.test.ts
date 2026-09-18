import { afterEach, expect, test, vi } from 'vitest';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  clearAsteroidShatters,
  drawRoidsRelative,
  recordAsteroidLatch,
} from '../../../src/entities/roid/roidRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { canvasManager } from '../../../src/rendering/canvasSurface';

afterEach(() => {
  clearAsteroidShatters();
  vi.restoreAllMocks();
});

test('a latch shakes only the drawn asteroid and settles after a quarter second', () => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas unavailable');
  }
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 500, height: 500 });
  vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out) =>
    Object.assign(out, { x: 250, y: 250 })
  );
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const line = vi.spyOn(ctx, 'moveTo');
  const roid = new Roid({ x: 100, y: 50 }, 20, 'cargo');
  const ship = new Ship({ position: { x: 0, y: 0 } });
  const pose = { ...roid.position };
  const velocity = { ...roid.velocity };
  drawRoidsRelative(ship, [roid]);
  const resting = [...(line.mock.calls[0] ?? [])];
  line.mockClear();
  recordAsteroidLatch('cargo');
  clock.mockReturnValue(1015);
  drawRoidsRelative(ship, [roid]);
  expect(line.mock.calls[0]).not.toEqual(resting);
  expect(roid.position).toEqual(pose);
  expect(roid.velocity).toEqual(velocity);
  line.mockClear();
  clock.mockReturnValue(1240);
  drawRoidsRelative(ship, [roid]);
  expect(line.mock.calls[0]).toEqual(resting);
});
