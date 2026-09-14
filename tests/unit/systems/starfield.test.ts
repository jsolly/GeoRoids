import { afterEach, expect, test, vi } from 'vitest';
import { drawStarfield } from '../../../src/rendering/starfield';

const view = vi.hoisted(() => ({ width: 1920, height: 1080, scale: 1, points: [] as number[][] }));
vi.mock('../../../src/rendering/canvas', () => ({
  canvasManager: {
    getCanvas: () => ({}),
    getContext: () => ({
      fillStyle: '',
      fillRect: (x: number, y: number, width: number, height: number) => {
        view.points.push([x, y, width, height]);
      },
    }),
    getViewportSize: () => view,
    getPlayfieldScale: () => view.scale,
    worldToScreenInto: (
      out: { x: number; y: number },
      point: { x: number; y: number },
      camera: { x: number; y: number }
    ) => {
      out.x = view.width / 2 + (point.x - camera.x) * view.scale;
      out.y = view.height / 2 + (point.y - camera.y) * view.scale;
      return out;
    },
  },
}));
afterEach(() => {
  view.scale = 1;
  view.points = [];
});

function sky(x: number, y: number) {
  view.points = [];
  drawStarfield({ x, y });
  return view.points;
}

test('launch and distant sectors retain a sparse visible sky on a 1080p viewport', () => {
  for (const [x, y] of [
    [0, 0],
    [40_000, 24_000],
  ] as const) {
    const stars = sky(x, y);
    expect(stars.length).toBeGreaterThanOrEqual(15);
    expect(stars.length).toBeLessThanOrEqual(80);
    expect(
      stars.every(
        ([px, py, width, height]) =>
          px !== undefined &&
          py !== undefined &&
          px >= -1 &&
          px <= 1921 &&
          py >= -1 &&
          py <= 1081 &&
          width === 1 &&
          height === 1
      )
    ).toBe(true);
  }
});

test('returning after distant travel reconstructs the same stars without drift', () => {
  const original = sky(0, 0);
  for (let x = 4000; x < 50_000; x += 4000) {
    sky(x, 0);
  }
  expect(sky(0, 0)).toEqual(original);
});

test('zooming out fills all visible world tiles, including the viewport edges', () => {
  view.scale = 0.5;
  const stars = sky(0, 0);
  expect(stars.length).toBeGreaterThan(70);
  expect(stars.some(([x]) => x !== undefined && x < 150)).toBe(true);
  expect(stars.some(([x]) => x !== undefined && x > 1770)).toBe(true);
});
