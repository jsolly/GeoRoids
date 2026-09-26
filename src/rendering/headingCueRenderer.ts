import { PALETTE, STEERING } from '../constants';
import type { Ship } from '../entities/ship/Ship';
import { canvasManager } from './canvasSurface';
import { PLAYFIELD_CLOSE_SCALE, type PlayfieldSize } from './playfieldCamera';

/** Screen-pixel distance from ship center to the heading caret tip. */
export function headingCueTipDistance(scaledShipRadius: number): number {
  return Math.max(STEERING.ARROW_DISTANCE_PX, scaledShipRadius + 32);
}

/** The current travel heading stays visible beyond a finger resting on the hull. */
export function drawHeadingCue(
  ctx: CanvasRenderingContext2D,
  viewport: PlayfieldSize,
  ship: Ship
): void {
  if (ship.exploding || ship.health <= 0) {
    return;
  }
  const tip = headingCueTipDistance(ship.r * PLAYFIELD_CLOSE_SCALE);
  ctx.save();
  ctx.translate(viewport.width / 2, viewport.height / 2);
  ctx.rotate(canvasManager.getCameraRotation() - ship.angle);
  ctx.beginPath();
  ctx.moveTo(tip - STEERING.ARROW_LENGTH_PX, -STEERING.ARROW_HALF_WIDTH_PX);
  ctx.lineTo(tip, 0);
  ctx.lineTo(tip - STEERING.ARROW_LENGTH_PX, STEERING.ARROW_HALF_WIDTH_PX);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.BG;
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = PALETTE.HUD;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}
