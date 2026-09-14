import { PALETTE, STEERING } from '../constants';
import type { Ship } from '../entities/ship/Ship';
import { PLAYFIELD_CLOSE_SCALE, type PlayfieldSize } from './playfieldCamera';

/** The current travel heading stays visible beyond a finger resting on the hull. */
export function drawHeadingCue(
  ctx: CanvasRenderingContext2D,
  viewport: PlayfieldSize,
  ship: Ship
): void {
  if (ship.exploding || ship.health <= 0) {
    return;
  }
  const tip = Math.max(STEERING.ARROW_DISTANCE_PX, ship.r * PLAYFIELD_CLOSE_SCALE + 32);
  ctx.save();
  ctx.translate(viewport.width / 2, viewport.height / 2);
  ctx.rotate(-ship.angle);
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
