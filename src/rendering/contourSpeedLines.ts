import { PALETTE } from '../constants';
import type { DrawingContext } from './drawingContext';

/** Moving streamline segments bow around the hull as terrain adds speed. */
export function drawContourSpeedLines(
  ctx: DrawingContext,
  x: number,
  y: number,
  angle: number,
  radius: number,
  strength: number,
  now: number
): void {
  if (strength <= 0) {
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-angle);
  ctx.strokeStyle = PALETTE.CONTOUR;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let index = 0; index < 6; index++) {
    const phase = (now / 1100 + index / 6) % 1;
    const band = Math.floor(index / 2);
    const side = index % 2 === 0 ? 1 : -1;
    const lane = 0.2 + band * 0.5;
    const head = 0.35 - phase * 2.8;
    const length = 1.5 + strength * 1.1;
    ctx.globalAlpha = strength * Math.sin(Math.PI * phase) * 0.45;
    ctx.beginPath();
    // Sample a smooth streamline rather than bend rigid dashes with the ship.
    // Segments begin at the shoulders and travel aft, never ahead of the nose.
    for (let point = 0; point <= 16; point++) {
      const along = head - (point / 16) * length;
      const shoulder = (0.65 - band * 0.1) * Math.exp(-(((along - 0.15) / 1.25) ** 2));
      const px = along * radius;
      const py = side * (lane + shoulder) * radius;
      if (point === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
