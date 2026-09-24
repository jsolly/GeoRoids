import type { Position, SatellitePickupData } from '../../../shared-types';
import type { DrawingContext } from '../../rendering/drawingContext';
import { hexToRgba } from '../../utils/colorUtils';

/** A stationary halo marks uncollected hardware without implying an active orbit. */
export function drawSatellitePickupGlow(
  ctx: DrawingContext,
  pickup: Pick<SatellitePickupData, 'state' | 'color'>,
  center: Position,
  hullRadius: number
): void {
  if (pickup.state !== 'loose') {
    return;
  }
  const radius = hullRadius * 2.5 + 6;
  const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
  glow.addColorStop(0, hexToRgba(pickup.color, 0.4));
  glow.addColorStop(0.35, hexToRgba(pickup.color, 0.22));
  glow.addColorStop(1, hexToRgba(pickup.color, 0));
  ctx.save();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
