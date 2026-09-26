import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import type { ContourLevel } from '../physics/terrain/contours';
import { getTerrainContours } from '../physics/terrain/terrainSession';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import { contourCandidates } from './contourSpatialIndex';
import { rotatedViewSize } from './travelCamera';

type ContourSegment = ContourLevel['segments'][number];

const contourPathCache = new WeakMap<readonly ContourSegment[], Path2D>();

/**
 * Neutral contour currents in world space. Keep alpha low so
 * ships, lasers, and roids stay readable on top.
 */
export function drawIsoContours(shipPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const pad = 32;
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const viewRadius =
    Math.hypot(viewport.width / 2, viewport.height / 2) / Math.max(scale, Number.EPSILON) +
    pad / Math.max(scale, Number.EPSILON);
  const levels = getTerrainContours(shipPosition, viewRadius);
  if (levels.length === 0) {
    return;
  }

  const rotation = canvasManager.getCameraRotation();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;

  const view = {
    ...shipPosition,
    ...rotatedViewSize(viewport.width, viewport.height, rotation),
    scale,
    pad,
  };
  for (const [levelOrdinal, level] of levels.entries()) {
    const isIndex = level.index % VISUAL.CONTOUR_INDEX_EVERY === 0;
    ctx.strokeStyle = hexToRgba(
      PALETTE.CONTOUR,
      isIndex ? VISUAL.CONTOUR_INDEX_ALPHA : VISUAL.CONTOUR_ALPHA
    );
    ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH;
    ctx.beginPath();

    const candidates = contourCandidates(levels, levelOrdinal, view);
    if (candidates.length === 0) {
      continue;
    }

    let path = contourPathCache.get(candidates);
    if (!path) {
      path = new Path2D();
      for (const segment of candidates) {
        path.moveTo(segment.ax, segment.ay);
        path.lineTo(segment.bx, segment.by);
      }
      contourPathCache.set(candidates, path);
    }

    ctx.save();
    canvasManager.applyWorldTransform(ctx, shipPosition);
    ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH / scale;
    ctx.stroke(path);
    ctx.restore();
  }

  ctx.restore();
}
