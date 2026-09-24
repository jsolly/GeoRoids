import { cruiseVelocity } from '../../shared/shipFlight';
import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import type { ContourLevel } from '../physics/terrain/contours';
import { getTerrainContours, getTerrainField } from '../physics/terrain/terrainSession';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import { contourSlopeHex, previewConeWeight, radialSlope } from './contourAppearance';
import { contourSlope } from './contourDisplay';
import { drawContourLabels } from './contourLabels';
import { contourCandidates } from './contourSpatialIndex';

type ContourSegment = ContourLevel['segments'][number];

const contourPathCache = new WeakMap<readonly ContourSegment[], Path2D>();

/**
 * Original-density terrain lines in world space. Keep alpha low so
 * ships, lasers, and roids stay readable on top.
 */
export function drawIsoContours(shipPosition: Position, headingAngle: number): void {
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

  const field = getTerrainField();
  const heading = cruiseVelocity(headingAngle, 1);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;

  const view = { ...shipPosition, ...viewport, scale, pad };
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
    ctx.translate(centerX - shipPosition.x * scale, centerY - shipPosition.y * scale);
    ctx.scale(scale, scale);
    ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH / scale;
    ctx.stroke(path);
    ctx.restore();

    for (const segment of candidates) {
      const offset = {
        x: ((segment.ax + segment.bx) / 2 - shipPosition.x) * scale,
        y: ((segment.ay + segment.by) / 2 - shipPosition.y) * scale,
      };
      const weight = previewConeWeight(offset, heading);
      const slope = contourSlope(segment, field);
      if (weight === 0 && slope.passage === 0) {
        continue;
      }
      const climb = radialSlope(offset, slope.gradient);
      const ax = centerX + (segment.ax - shipPosition.x) * scale;
      const ay = centerY + (segment.ay - shipPosition.y) * scale;
      const bx = centerX + (segment.bx - shipPosition.x) * scale;
      const by = centerY + (segment.by - shipPosition.y) * scale;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = hexToRgba(
        contourSlopeHex(weight > 0 ? climb : 0, slope.passage),
        Math.max(0.92 * weight, 0.95 * slope.passage)
      );
      ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH;
      ctx.stroke();
    }
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
