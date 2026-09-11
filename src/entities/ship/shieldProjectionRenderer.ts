import type { Position } from '../../../shared-types';
import { PALETTE } from '../../constants';
import { canvasManager } from '../../rendering/canvas';

/** A narrow mint link leaves both hulls and the recipient's shield ring visible. */
export function drawShieldProjectionLink(
  caster: Position,
  recipient: Position,
  viewer: Position
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const start = canvasManager.worldToScreen(caster, viewer);
  const end = canvasManager.worldToScreen(recipient, viewer);
  ctx.save();
  ctx.strokeStyle = PALETTE.SHIELD;
  ctx.lineWidth = 1.25;
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
