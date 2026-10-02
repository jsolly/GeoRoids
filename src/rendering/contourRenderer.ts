import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import type { ContourLevel } from '../physics/terrain/contours';
import { getTerrainContours } from '../physics/terrain/terrainSession';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import { createContourQuery } from './contourSpatialIndex';
import { rotatedViewSize } from './travelCamera';

type ContourSegment = ContourLevel['segments'][number];

const contourPathCache = new WeakMap<readonly ContourSegment[], Path2D>();
const playfieldCandidates = createContourQuery();

/** The same local candidate sequence feeds the Canvas and GPU rear layers. */
export function visibleContourLayers(shipPosition: Position) {
  const pad = 32;
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const viewRadius =
    Math.hypot(viewport.width / 2, viewport.height / 2) / Math.max(scale, Number.EPSILON) +
    pad / Math.max(scale, Number.EPSILON);
  const levels = getTerrainContours(shipPosition, viewRadius);
  const view = {
    ...shipPosition,
    ...rotatedViewSize(viewport.width, viewport.height, canvasManager.getCameraRotation()),
    scale,
    pad,
  };
  return levels.map((level, ordinal) => ({
    index: level.index,
    segments: playfieldCandidates(levels, ordinal, view),
  }));
}

/**
 * Neutral contour currents in world space. Keep alpha low so
 * ships, lasers, and roids stay readable on top.
 */
export function drawIsoContours(shipPosition: Position): number {
  return drawContourLayers(shipPosition, visibleContourLayers(shipPosition));
}

/** Shared native painter for ordinary Canvas frames and subpixel GPU-frame contours. */
export function drawContourLayers(
  shipPosition: Position,
  levels: readonly { index: number; segments: readonly ContourSegment[] }[]
): number {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return 0;
  }

  const scale = canvasManager.getPlayfieldScale();
  if (levels.length === 0) {
    return 0;
  }
  let submittedSegments = 0;

  ctx.save();
  try {
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

      const candidates = level.segments;
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
      try {
        canvasManager.applyWorldTransform(ctx, shipPosition);
        ctx.lineWidth = VISUAL.CONTOUR_STROKE_WIDTH / scale;
        ctx.stroke(path);
        submittedSegments += candidates.length;
      } finally {
        ctx.restore();
      }
    }
  } finally {
    ctx.restore();
  }
  return submittedSegments;
}
