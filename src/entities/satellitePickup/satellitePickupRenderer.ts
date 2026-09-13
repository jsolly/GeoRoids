import type { Position } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import { resolveGlow } from '../../rendering/renderQuality';
import { drawEoSatelliteOutline } from '../satellite/eoOutlines';
import type { SatellitePickup } from './SatellitePickup';

export function drawSatellitePickups(pickups: SatellitePickup[], viewer: Position): void {
  for (const pickup of pickups) {
    if (pickup.state !== 'broken' && pickup.health > 0) {
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
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(VISUAL.SHIP_GLOW);
  ctx.globalAlpha = pickup.state === 'orbiting' ? 0.9 : 1;
  drawEoSatelliteOutline(ctx, pickup.typeId, radius, pickup.angle, color);
  ctx.restore();

  if (pickup.health < pickup.maxHealth) {
    const width = radius * 2.4;
    const left = screen.x - width / 2;
    const top = screen.y - radius * 1.5 - 6;
    ctx.save();
    ctx.lineWidth = VISUAL.HEALTH_CAPSULE_HEIGHT;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = PALETTE.HUD_MUTED;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + width, top);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PALETTE.HEALTH;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + width * Math.max(0, pickup.health / pickup.maxHealth), top);
    ctx.stroke();
    ctx.restore();
  }
}
