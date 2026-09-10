import type { Position } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import type { DrawingContext } from '../../rendering/drawingContext';
import { hexToRgba } from '../../utils/colorUtils';
import type { SatellitePickup } from './SatellitePickup';

export function drawSatellitePickups(pickups: SatellitePickup[], viewer: Position): void {
  for (const pickup of pickups) {
    drawSatellitePickup(pickup, viewer);
  }
}

function drawSatellitePickup(pickup: SatellitePickup, viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const screen = canvasManager.worldToScreen(pickup.position, viewer);
  const radius = Math.max(4, pickup.radius * canvasManager.getPlayfieldScale());
  const color = pickup.color || PALETTE.SATELLITE_PICKUP;
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(-pickup.angle);
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  ctx.lineWidth = VISUAL.SHIP_STROKE_WIDTH;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.globalAlpha = pickup.state === 'orbiting' ? 0.9 : 1;

  if (pickup.typeId === 'echo') {
    drawEchoHardware(ctx, radius);
  } else {
    drawRelayHardware(ctx, radius);
  }
  ctx.restore();
}

function drawEchoHardware(ctx: DrawingContext, radius: number): void {
  // Echo: compact comms bus, mast, and open dish.
  ctx.beginPath();
  ctx.roundRect(-radius * 0.65, -radius * 0.42, radius * 1.3, radius * 0.84, radius * 0.16);
  ctx.moveTo(0, -radius * 0.42);
  ctx.lineTo(0, -radius * 1.05);
  ctx.moveTo(-radius * 0.9, radius * 0.65);
  ctx.lineTo(radius * 0.9, radius * 0.65);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(radius * 0.42, -radius * 0.95, radius * 0.48, Math.PI, 0);
  ctx.moveTo(radius * 0.42, -radius * 0.95);
  ctx.lineTo(radius * 0.42, -radius * 0.56);
  ctx.stroke();
}

function drawRelayHardware(ctx: DrawingContext, radius: number): void {
  // Relay: tall relay box with two opposed paddles and a cross-link boom.
  ctx.beginPath();
  ctx.rect(-radius * 0.38, -radius * 0.7, radius * 0.76, radius * 1.4);
  ctx.moveTo(-radius * 0.38, 0);
  ctx.lineTo(-radius * 1.25, -radius * 0.48);
  ctx.lineTo(-radius * 1.25, radius * 0.48);
  ctx.lineTo(-radius * 0.38, 0);
  ctx.moveTo(radius * 0.38, 0);
  ctx.lineTo(radius * 1.25, -radius * 0.48);
  ctx.lineTo(radius * 1.25, radius * 0.48);
  ctx.lineTo(radius * 0.38, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-radius * 0.9, -radius * 0.48);
  ctx.lineTo(radius * 0.9, radius * 0.48);
  ctx.stroke();
}

export function drawSatellitePickupMiniMapDot(ctx: DrawingContext, x: number, y: number): void {
  ctx.save();
  ctx.strokeStyle = hexToRgba(PALETTE.SATELLITE_PICKUP, 0.95);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, VISUAL.MINIMAP_DOT / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
