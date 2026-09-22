/* @vitest-environment node */
import { createCanvas } from 'canvas';
import { expect, test, vi } from 'vitest';
import type { ShipKitId } from '../../../shared-types';
import { VISUAL } from '../../../src/constants';
import {
  drawIsolineWingWind,
  isolineWingStreaks,
} from '../../../src/entities/ship/isolineWingWind';

function laneCenters(kitId: ShipKitId, timeMs: number, p: number): number[] {
  return isolineWingStreaks(0, 0, 20, 0, kitId, timeMs)
    .filter((streak) => streak.p === p)
    .map((streak) => streak.f)
    .sort((left, right) => right - left);
}

test.each(['surveyor', 'hauler'] as const)(
  '%s wing ticks slide aft on both wings and are not drawn when the lane is off',
  (kitId) => {
    const period = VISUAL.ISOLINE_WIND_PERIOD_MS;
    const early = isolineWingStreaks(80, 90, 24, 0, kitId, period * 0.2);
    const later = isolineWingStreaks(80, 90, 24, 0, kitId, period * 0.32);
    expect(early.some((streak) => streak.p > 0)).toBe(true);
    expect(early.some((streak) => streak.p < 0)).toBe(true);
    const lane = early[0];
    if (!lane) {
      throw new Error('expected wing ticks');
    }
    const before = laneCenters(kitId, period * 0.45, lane.p);
    const after = laneCenters(kitId, period * 0.55, lane.p);
    expect(after.length).toBe(before.length);
    expect(after.length).toBeGreaterThan(0);
    for (let index = 0; index < before.length; index++) {
      const earlier = before[index];
      const moved = after[index];
      if (earlier === undefined || moved === undefined) {
        throw new Error('missing wing tick');
      }
      expect(moved).toBeLessThan(earlier);
    }
    const sample = early.find((streak) => streak.p === lane.p);
    if (!sample) {
      throw new Error('missing projected wing tick');
    }
    const dashPx = sample.x2 - sample.x1;
    expect(dashPx).toBeGreaterThanOrEqual(7);
    expect(sample.x1).toBeCloseTo(80 + 24 * sample.f - dashPx / 2);
    expect(sample.y1).toBeCloseTo(90 + 24 * sample.p);
    const laneStreaks = early
      .filter((streak) => streak.p === lane.p)
      .sort((left, right) => right.f - left.f);
    expect(laneStreaks.length).toBeGreaterThan(1);
    for (let index = 0; index < laneStreaks.length - 1; index++) {
      const lead = laneStreaks[index];
      const trail = laneStreaks[index + 1];
      if (!lead || !trail) {
        throw new Error('missing wing tick');
      }
      expect((lead.f - trail.f) * 24).toBeGreaterThan(dashPx);
    }

    const ctx = createCanvas(200, 200).getContext('2d');
    const stroke = vi.spyOn(ctx, 'stroke');
    drawIsolineWingWind(ctx, 80, 90, 24, 0, kitId, '#5EEAD4', period * 0.2, false);
    expect(stroke).not.toHaveBeenCalled();
    drawIsolineWingWind(ctx, 80, 90, 24, 0, kitId, '#5EEAD4', period * 0.2, true);
    expect(stroke.mock.calls.length).toBeGreaterThan(0);
    expect(later.length).toBeGreaterThan(0);
  }
);
