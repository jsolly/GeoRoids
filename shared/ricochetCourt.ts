import type { Position } from '../shared-types';

/** One public landmark near Town Square, outside its launch and respawn ring. */
export const RICOCHET_COURT = {
  name: 'Ricochet Court',
  center: { x: 800, y: -650 },
  radius: 360,
} as const;

/** Corner panels leave wide cardinal entrances. Ships pass through every panel. */
export const COURT_REFLECTORS = [
  { start: { x: 110, y: -310 }, end: { x: 310, y: -110 } },
  { start: { x: 310, y: 110 }, end: { x: 110, y: 310 } },
  { start: { x: -110, y: 310 }, end: { x: -310, y: 110 } },
  { start: { x: -310, y: -110 }, end: { x: -110, y: -310 } },
].map(({ start, end }) => ({
  start: { x: start.x + RICOCHET_COURT.center.x, y: start.y + RICOCHET_COURT.center.y },
  end: { x: end.x + RICOCHET_COURT.center.x, y: end.y + RICOCHET_COURT.center.y },
}));

/** Swept, two-sided line contact, including endpoints and a muzzle on a panel. */
export function findCourtImpact(start: Position, end: Position) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return null;
  }
  let nearest: { point: Position; normal: Position; distance: number } | null = null;
  for (const panel of COURT_REFLECTORS) {
    const px = panel.end.x - panel.start.x;
    const py = panel.end.y - panel.start.y;
    const cross = dx * py - dy * px;
    if (Math.abs(cross) < 1e-9) {
      continue;
    }
    const qx = panel.start.x - start.x;
    const qy = panel.start.y - start.y;
    const t = (qx * py - qy * px) / cross;
    const u = (qx * dy - qy * dx) / cross;
    if (t < 0 || t > 1 || u < 0 || u > 1 || (nearest && t * distance >= nearest.distance)) {
      continue;
    }
    const length = Math.hypot(px, py);
    // Match the world wall's normal convention: point toward the incoming side's exit.
    const sign = cross > 0 ? 1 : -1;
    nearest = {
      point: { x: start.x + dx * t, y: start.y + dy * t },
      normal: { x: (py / length) * sign, y: (-px / length) * sign },
      distance: t * distance,
    };
  }
  return nearest;
}
