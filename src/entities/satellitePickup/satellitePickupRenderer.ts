import type { Position } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvasSurface';
import { resolveGlow } from '../../rendering/renderQuality';
import { drawEoSatelliteOutline } from '../satellite/eoOutlines';
import type { SatellitePickup } from './SatellitePickup';
import { drawSatelliteHealth } from './satelliteHealthRenderer';
import { drawSatellitePickupGlow } from './satellitePickupGlow';

export function drawSatellitePickups(pickups: SatellitePickup[], viewer: Position): void {
  for (const pickup of pickups) {
    if ((pickup.state === 'loose' || pickup.state === 'orbiting') && pickup.health > 0) {
      drawSatellitePickup(pickup, viewer);
    }
  }
}

function drawSatellitePickup(pickup: SatellitePickup, viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const screen = canvasManager.worldToScreen(pickup.position, viewer);
  const radius = Math.max(5, pickup.radius * canvasManager.getPlayfieldScale());
  const color = pickup.color || PALETTE.SATELLITE;
  drawSatellitePickupGlow(ctx, pickup, screen, radius);
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.shadowColor = color;
  ctx.shadowBlur = pickup.state === 'loose' ? resolveGlow(VISUAL.SHIP_GLOW) : 0;
  ctx.globalAlpha = pickup.state === 'orbiting' ? 0.9 : 1;
  drawEoSatelliteOutline(ctx, pickup.typeId, radius, pickup.angle, color);
  ctx.restore();

  drawSatelliteHealth(ctx, pickup, screen, radius);
}
