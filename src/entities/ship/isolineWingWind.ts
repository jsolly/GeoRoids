import type { ShipKitId } from '../../../shared-types';
import { VISUAL } from '../../constants';
import type { DrawingContext } from '../../rendering/drawingContext';
import { strokePhosphorPolyline } from '../../rendering/vectorJuice';
import { projectHullPoint } from './hullOutlines';

interface WingLane {
  p: number;
  fStart: number;
  fEnd: number;
}

const DASHES_PER_LANE = 2;
const HULL_DASH_HALF = 0.08;
/** Flight-scale hulls are about 15px; keep each tick long enough to read. */
const MIN_DASH_PX = 7;
const MIN_WAVE = 0.28;

/**
 * Local hull tracks: +f is forward. Lanes sit on the wings and run well aft
 * of the trailing edge so two ticks can move without sitting on each other.
 */
const WING_LANES: Record<ShipKitId, readonly WingLane[]> = {
  surveyor: [
    { p: -0.72, fStart: 0.18, fEnd: -1.62 },
    { p: -1.02, fStart: 0.34, fEnd: -1.4 },
    { p: 0.72, fStart: 0.18, fEnd: -1.62 },
    { p: 1.02, fStart: 0.34, fEnd: -1.4 },
  ],
  hauler: [
    { p: -0.8, fStart: 0.42, fEnd: -1.55 },
    { p: -1.1, fStart: 0.22, fEnd: -1.45 },
    { p: 0.8, fStart: 0.42, fEnd: -1.55 },
    { p: 1.1, fStart: 0.22, fEnd: -1.45 },
  ],
};

function dashHalf(radius: number): number {
  return Math.max(HULL_DASH_HALF, MIN_DASH_PX / (2 * radius));
}

interface IsolineWingStreak {
  f: number;
  p: number;
  alpha: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Wind ticks on both wings. `f` is the tick center; it decreases as the tick slides aft. */
export function isolineWingStreaks(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  kitId: ShipKitId,
  timeMs: number
): IsolineWingStreak[] {
  const period = VISUAL.ISOLINE_WIND_PERIOD_MS;
  const cycle = ((timeMs % period) + period) % period;
  const base = cycle / period;
  const streaks: IsolineWingStreak[] = [];
  for (const lane of WING_LANES[kitId]) {
    const span = lane.fEnd - lane.fStart;
    for (let index = 0; index < DASHES_PER_LANE; index++) {
      const t = (base + index / DASHES_PER_LANE) % 1;
      const wave = Math.sin(Math.PI * t);
      if (wave < MIN_WAVE) {
        continue;
      }
      const alpha = 0.62 + 0.38 * wave;
      const half = dashHalf(radius);
      const f = lane.fStart + span * t;
      const start = projectHullPoint(centerX, centerY, radius, angle, {
        f: f - half,
        p: lane.p,
      });
      const end = projectHullPoint(centerX, centerY, radius, angle, {
        f: f + half,
        p: lane.p,
      });
      streaks.push({
        f,
        p: lane.p,
        alpha,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
      });
    }
  }
  return streaks;
}

/** Draws nothing unless the parallel isoline lane is active. */
export function drawIsolineWingWind(
  ctx: DrawingContext,
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  kitId: ShipKitId,
  color: string,
  timeMs: number,
  active: boolean
): void {
  if (!active) {
    return;
  }
  for (const streak of isolineWingStreaks(centerX, centerY, radius, angle, kitId, timeMs)) {
    strokePhosphorPolyline(
      ctx,
      [
        { x: streak.x1, y: streak.y1 },
        { x: streak.x2, y: streak.y2 },
      ],
      color,
      VISUAL.ISOLINE_WIND_STROKE_WIDTH,
      VISUAL.ISOLINE_WIND_GLOW,
      false,
      streak.alpha
    );
  }
}
