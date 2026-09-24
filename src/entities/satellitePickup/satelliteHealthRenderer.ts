import type { Position, SatellitePickupData } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import type { DrawingContext } from '../../rendering/drawingContext';
import { hexToRgba } from '../../utils/colorUtils';

/** Match the ship's thin health bar; hide it for full health or undeployed hardware. */
export function drawSatelliteHealth(
  ctx: DrawingContext,
  pickup: Pick<SatellitePickupData, 'state' | 'health' | 'maxHealth'>,
  center: Position,
  hullRadius: number,
  showFullHealth = false
): void {
  if (pickup.state !== 'orbiting' || (!showFullHealth && pickup.health >= pickup.maxHealth)) {
    return;
  }
  const width = hullRadius * 2.4;
  const left = center.x - width / 2;
  const top = center.y - hullRadius - 10;
  const fraction = Math.max(0, pickup.health / pickup.maxHealth);
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.lineWidth = VISUAL.HEALTH_CAPSULE_HEIGHT;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.45);
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left + width, top);
  ctx.stroke();
  if (fraction > 0) {
    ctx.strokeStyle = PALETTE.HEALTH;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + width * fraction, top);
    ctx.stroke();
  }
  ctx.restore();
}
