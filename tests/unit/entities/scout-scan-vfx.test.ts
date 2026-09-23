import { afterEach, expect, test, vi } from 'vitest';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import {
  drawScoutScanFx,
  type ScoutScanVisualHost,
  scoutScanPulseGeometry,
} from '../../../src/entities/ship/shipRenderer';

afterEach(() => {
  vi.restoreAllMocks();
});

function radarContext(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Scout radar scenarios require a canvas context');
  }
  return context;
}

function scoutHost(): ScoutScanVisualHost {
  return {
    kitId: 'scout',
    abilityActiveFrames: SHIP_ABILITY.SCAN_FRAMES,
    health: 100,
    exploding: false,
  };
}

test('an active Scout pulse starts at the hull and reaches the farthest desktop corner', () => {
  const viewport = { width: 800, height: 600 };
  const start = scoutScanPulseGeometry(0, 400, 300, 24, SHIP_ABILITY.SCAN_FRAMES, viewport);
  const midpoint = scoutScanPulseGeometry(0, 400, 300, 24, 300, viewport);
  const edge = scoutScanPulseGeometry(0, 400, 300, 24, 241, viewport);

  expect(start?.radius).toBe(24);
  expect(start?.alpha).toBeGreaterThan(0);
  expect(midpoint?.radius).toBeGreaterThan(start?.radius ?? 0);
  expect(midpoint?.alpha).toBeCloseTo(start?.alpha ?? 0);
  expect(edge?.radius).toBeGreaterThan(Math.hypot(400, 300) * 1.08);
  expect(edge?.alpha).toBeGreaterThan(0);
  expect(scoutScanPulseGeometry(0, 400, 300, 24, 240, viewport)).toBeUndefined();
  expect(scoutScanPulseGeometry(1, 400, 300, 24, 240, viewport)?.radius).toBeCloseTo(24);
});

test('the final mobile pulse uses viewport pixels and fades without leaving a later pulse', () => {
  const viewport = { width: 390, height: 844 };
  const edge = scoutScanPulseGeometry(2, 195, 422, 24, 1, viewport);

  expect(edge?.radius).toBeGreaterThan(Math.hypot(195, 422) * 1.08);
  expect(edge?.alpha).toBeGreaterThan(0);
  expect(edge?.alpha).toBeLessThan(0.02);
  expect(scoutScanPulseGeometry(0, 195, 422, 24, 0, viewport)).toBeUndefined();
  expect(scoutScanPulseGeometry(1, 195, 422, 24, 0, viewport)).toBeUndefined();
  expect(scoutScanPulseGeometry(2, 195, 422, 24, 0, viewport)).toBeUndefined();
});

test('only a living active Scout paints the cyan sweep', () => {
  const context = radarContext();
  const arcs: number[] = [];
  const strokes: string[] = [];
  const arc = context.arc.bind(context);
  const stroke = context.stroke.bind(context);
  vi.spyOn(context, 'arc').mockImplementation((x, y, radius, start, end, anticlockwise) => {
    arcs.push(radius);
    arc(x, y, radius, start, end, anticlockwise);
  });
  vi.spyOn(context, 'stroke').mockImplementation(() => {
    strokes.push(String(context.strokeStyle));
    stroke();
  });

  const host = scoutHost();
  drawScoutScanFx(context, host, 400, 300, 24, { width: 800, height: 600 });
  expect(arcs).toHaveLength(1);
  expect(arcs[0]).toBe(24);
  expect(strokes).toHaveLength(1);
  expect(strokes[0]).toContain('94, 234, 212');

  arcs.length = 0;
  strokes.length = 0;
  drawScoutScanFx(context, { ...host, kitId: 'hauler' }, 400, 300, 24, {
    width: 800,
    height: 600,
  });
  drawScoutScanFx(context, { ...host, abilityActiveFrames: 0 }, 400, 300, 24, {
    width: 800,
    height: 600,
  });
  drawScoutScanFx(context, { ...host, health: 0 }, 400, 300, 24, { width: 800, height: 600 });
  drawScoutScanFx(context, { ...host, exploding: true }, 400, 300, 24, {
    width: 800,
    height: 600,
  });
  expect(arcs).toEqual([]);
  expect(strokes).toEqual([]);
});
