import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getGameBoundary } from '../physics/boundary';
import { logger } from '../utils/Logger';
import { canvasManager } from './canvas';
import { PLAYFIELD_CLOSE_SCALE } from './playfieldCamera';
import { resolveGlow } from './renderQuality';

export function drawFieryBoundary(shipPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();

  if (!ctx || !cvs) {
    logger.warn('BOUNDARY_RENDERER', 'Canvas or context not available');
    return;
  }

  const boundary = getGameBoundary();
  const center = canvasManager.worldToScreen({ x: boundary.cx, y: boundary.cy }, shipPosition);
  const centerX = center.x;
  const centerY = center.y;
  const viewport = canvasManager.getViewportSize();
  const radius = boundary.radius * PLAYFIELD_CLOSE_SCALE;

  // Skip the expensive glowing circle only when its edge is outside the whole
  // viewport. A circumscribed view radius plus glow padding keeps this conservative.
  const viewRadius =
    Math.hypot(viewport.width, viewport.height) / 2 +
    VISUAL.BOUNDARY_GLOW * 3 +
    VISUAL.BOUNDARY_STROKE_WIDTH / 2;
  const centerDistance = Math.hypot(centerX - viewport.width / 2, centerY - viewport.height / 2);
  if (radius > 0 && Math.abs(centerDistance - radius) > viewRadius) {
    return;
  }

  ctx.save();
  ctx.shadowColor = PALETTE.HUD_MUTED;
  ctx.shadowBlur = resolveGlow(VISUAL.BOUNDARY_GLOW);
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.lineWidth = VISUAL.BOUNDARY_STROKE_WIDTH;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
