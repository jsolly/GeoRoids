import { afterEach, expect, test, vi } from 'vitest';
import type { TerrainSpider } from '../../../shared-types';
import { Roid } from '../../../src/entities/roid/Roid';
import { setSpiderField } from '../../../src/physics/terrain/spiderSession';
import { drawBeltEncounters } from '../../../src/rendering/beltRenderer';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import { asteroidRow } from '../../support/asteroid-row';

afterEach(() => {
  setSpiderField(undefined);
  canvasManager.destroy();
  configureRenderQuality('', 'desktop');
  vi.restoreAllMocks();
});

/** Blur in force at each red eye fill of one visible belt crawler beside the pilot. */
function eyeBlurs(audience: 'desktop' | 'low-end'): number[] {
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  configureRenderQuality('', audience);
  const host = new Roid(asteroidRow({ x: 200, y: 0 }, 40, 'belt-host'));
  const crawler: TerrainSpider = {
    id: 'crawler',
    position: { x: 140, y: 0 },
    angle: 0,
    health: 3,
    maxHealth: 3,
    phase: 'scuttling',
    targetId: null,
    crawler: { hostId: host.id, anchor: { x: 160, y: 0 }, phase: 'escaping', progress: 0 },
  };
  setSpiderField({ spiders: [crawler], nests: [] });
  const ctx = canvasManager.requireContext();
  const blurs: number[] = [];
  const fillRect = ctx.fillRect.bind(ctx);
  vi.spyOn(ctx, 'fillRect').mockImplementation(function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D['fillRect']>
  ) {
    if (this.shadowColor === '#c91e39') {
      blurs.push(this.shadowBlur);
    }
    fillRect(...args);
  });
  drawBeltEncounters({ x: 0, y: 0 }, [host]);
  return blurs;
}

test('a visible belt crawler glows its red eyes at full quality', () => {
  const blurs = eyeBlurs('desktop');
  expect(blurs).toHaveLength(2);
  expect(Math.min(...blurs)).toBeGreaterThan(0);
});

test('a low-end pilot sees the same crawler eyes without glow', () => {
  expect(eyeBlurs('low-end')).toEqual([0, 0]);
});
