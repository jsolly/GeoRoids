import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getTerrainContours } from '../physics/terrain/terrainSession';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';
import { drawContourLabels } from './contourLabels';

/**
 * Muted topo lines in world space. Tight spacing is steep; keep alpha low so
 * ships, lasers, and roids stay readable on top.
 */
export function drawIsoContours(shipPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const levels = getTerrainContours();
  if (levels.length === 0) {
    return;
  }

  const pad = 32;
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;

  for (const level of levels) {
    const isIndex = level.index % VISUAL.CONTOUR_INDEX_EVERY === 0;
    ctx.strokeStyle = hexToRgba(
      PALETTE.CONTOUR,
      isIndex ? VISUAL.CONTOUR_INDEX_ALPHA : VISUAL.CONTOUR_ALPHA
    );
    ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH;
    ctx.beginPath();

    for (const segment of level.segments) {
      const ax = centerX + (segment.ax - shipPosition.x) * scale;
      const ay = centerY + (segment.ay - shipPosition.y) * scale;
      const bx = centerX + (segment.bx - shipPosition.x) * scale;
      const by = centerY + (segment.by - shipPosition.y) * scale;
      if (
        (ax < -pad && bx < -pad) ||
        (ax > viewport.width + pad && bx > viewport.width + pad) ||
        (ay < -pad && by < -pad) ||
        (ay > viewport.height + pad && by > viewport.height + pad)
      ) {
        continue;
      }
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }

    ctx.stroke();
  }

  drawContourLabels(ctx, levels, {
    width: viewport.width,
    height: viewport.height,
    x: shipPosition.x,
    y: shipPosition.y,
    scale,
    alpha: VISUAL.CONTOUR_LABEL_ALPHA,
    spacing: VISUAL.CONTOUR_LABEL_SPACING,
  });
  ctx.restore();
}
