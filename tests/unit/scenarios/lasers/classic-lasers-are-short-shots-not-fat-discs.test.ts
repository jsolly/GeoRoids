import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GAME, LASER } from '../../../../src/constants';
import { Laser } from '../../../../src/entities/laser/Laser';

const { recorder } = vi.hoisted(() => {
  const lineTos: Array<{ x: number; y: number }> = [];
  const arcs: number[] = [];
  let fillCount = 0;
  const lineWidths: number[] = [];

  const ctx = {
    shadowColor: '',
    shadowBlur: 0,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    save: () => {},
    restore: () => {},
    translate: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: (x: number, y: number) => {
      lineTos.push({ x, y });
    },
    stroke: () => {},
    fill: () => {
      fillCount += 1;
    },
    arc: (_x: number, _y: number, radius: number) => {
      arcs.push(radius);
    },
  };

  Object.defineProperty(ctx, 'lineWidth', {
    get() {
      return lineWidths.at(-1) ?? 0;
    },
    set(value: number) {
      lineWidths.push(value);
    },
  });

  return {
    recorder: {
      lineTos,
      arcs,
      lineWidths,
      get fillCount() {
        return fillCount;
      },
      reset() {
        lineTos.length = 0;
        arcs.length = 0;
        lineWidths.length = 0;
        fillCount = 0;
      },
      ctx,
    },
  };
});

vi.mock('../../../../src/rendering/canvas', () => ({
  canvasManager: {
    getContext: () => recorder.ctx,
    getCanvas: () => ({ width: 800, height: 600 }),
  },
}));

import { drawLaser } from '../../../../src/entities/laser/laserRenderer';

describe('Classic lasers are short shots, not fat discs', () => {
  beforeEach(() => {
    recorder.reset();
  });

  test('a live shot is a short stroke — a dot — not a filled disc', () => {
    const speed = LASER.SPEED / GAME.FPS;
    const laser = new Laser({ x: 0, y: 0 }, { x: speed, y: 0 }, 0, 0, false);

    drawLaser(laser, { x: 0, y: 0 });

    expect(recorder.lineTos.length).toBeGreaterThan(0);
    for (const point of recorder.lineTos) {
      expect(Math.hypot(point.x, point.y)).toBeLessThan(8);
    }
    expect(Math.max(...recorder.lineWidths)).toBeLessThanOrEqual(4);
    expect(recorder.fillCount).toBe(0);
    expect(recorder.arcs).toEqual([]);
    expect(speed * 0.1).toBeCloseTo(0.5);
  });
});
