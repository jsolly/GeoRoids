import { PALETTE, VISUAL } from '../../constants';

/** Thin cream tick under the lives/score cluster. Uses loot blush, never white. */
export function drawFuelGauge(
  ctx: CanvasRenderingContext2D,
  fuel: number,
  maxFuel: number,
  origin: { x: number; y: number; width?: number; height?: number }
): void {
  if (maxFuel <= 0) {
    return;
  }

  const barWidth =
    origin.width !== undefined && Number.isFinite(origin.width) && origin.width > 0
      ? origin.width
      : VISUAL.FUEL_BAR_WIDTH;
  const barHeight =
    origin.height !== undefined && Number.isFinite(origin.height) && origin.height > 0
      ? origin.height
      : VISUAL.FUEL_BAR_HEIGHT;
  const filled = barWidth * Math.max(0, Math.min(1, fuel / maxFuel));

  ctx.save();
  ctx.lineWidth = barHeight;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(origin.x + barWidth, origin.y);
  ctx.stroke();
  if (filled > 0) {
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(origin.x + filled, origin.y);
    ctx.stroke();
  }
  ctx.restore();
}
