import { PALETTE } from '../constants';

/** Clear every physical pixel, including fractional-DPR backing padding. */
export function paintOpaqueBackground(context: CanvasRenderingContext2D): void {
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.shadowColor = 'transparent';
    context.filter = 'none';
    context.fillStyle = PALETTE.BG;
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  } finally {
    context.restore();
  }
}
