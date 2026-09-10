import { PALETTE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import type { Laser } from './Laser';

export function drawLaser(laser: Laser, shipPosition: { x: number; y: number }): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();

  if (!ctx || !cvs || laser.explodeTime > 0) {
    return;
  }

  const viewport = canvasManager.getViewportSize();
  const screenX = laser.position.x - shipPosition.x + viewport.width / 2;
  const screenY = laser.position.y - shipPosition.y + viewport.height / 2;

  drawLaserBeam(ctx, screenX, screenY, laser);
}

function drawLaserBeam(ctx: CanvasRenderingContext2D, x: number, y: number, laser: Laser): void {
  ctx.save();
  ctx.translate(x, y);

  ctx.shadowColor = PALETTE.LASER_LOCAL;
  ctx.shadowBlur = VISUAL.LASER_GLOW;
  ctx.strokeStyle = PALETTE.LASER_LOCAL;
  ctx.lineWidth = VISUAL.LASER_STROKE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(laser.velocity.x * 0.1, laser.velocity.y * 0.1);
  ctx.stroke();

  ctx.restore();
}
