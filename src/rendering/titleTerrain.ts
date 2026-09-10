import { PALETTE, VISUAL } from '../constants';
import { getGameBoundary } from '../physics/boundary';
import { extractIsoContours } from '../physics/terrain/contours';
import { createHeightfield } from '../physics/terrain/heightfield';
import { TERRAIN } from '../physics/terrain/terrainConfig';
import { hexToRgba } from '../utils/colorUtils';
import { drawContourLabels } from './contourLabels';
import { watchDevicePixelRatio } from './devicePixelRatioWatcher';

let stopDevicePixelRatioWatcher: (() => void) | null = null;
let stopResizeListener: (() => void) | null = null;

/** A fixed terrain preview, independent of the live room's terrain cache. */
export function initTitleTerrain(): void {
  stopDevicePixelRatioWatcher?.();
  stopDevicePixelRatioWatcher = null;
  stopResizeListener?.();
  stopResizeListener = null;

  const canvas = document.getElementById('title-terrain');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  const bounds = getGameBoundary();
  const contours = extractIsoContours(
    createHeightfield(TERRAIN.DEFAULT_SEED, bounds),
    VISUAL.TITLE_TERRAIN_GRID_SIZE,
    VISUAL.TITLE_TERRAIN_LEVELS
  );
  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(0, 0, width, height);

    // Crop inside the arena boundary; preserve the terrain's proportions on phones.
    const scale = Math.max(width, height) / VISUAL.TITLE_TERRAIN_VIEW_SPAN;
    ctx.lineCap = 'round';
    for (const level of contours) {
      const isIndex = level.index % VISUAL.CONTOUR_INDEX_EVERY === 0;
      ctx.strokeStyle = hexToRgba(
        PALETTE.CONTOUR,
        isIndex ? VISUAL.TITLE_CONTOUR_INDEX_ALPHA : VISUAL.TITLE_CONTOUR_ALPHA
      );
      ctx.lineWidth = isIndex ? VISUAL.TITLE_CONTOUR_INDEX_WIDTH : VISUAL.TITLE_CONTOUR_WIDTH;
      ctx.beginPath();
      for (const segment of level.segments) {
        ctx.moveTo(
          width / 2 + (segment.ax - bounds.cx) * scale,
          height / 2 + (segment.ay - bounds.cy) * scale
        );
        ctx.lineTo(
          width / 2 + (segment.bx - bounds.cx) * scale,
          height / 2 + (segment.by - bounds.cy) * scale
        );
      }
      ctx.stroke();
    }

    drawContourLabels(ctx, contours, {
      width,
      height,
      x: bounds.cx,
      y: bounds.cy,
      scale,
      alpha: VISUAL.TITLE_LABEL_ALPHA,
      spacing: VISUAL.TITLE_LABEL_SPACING,
    });
  };

  resize();
  window.addEventListener('resize', resize);
  stopResizeListener = (): void => {
    window.removeEventListener('resize', resize);
  };
  stopDevicePixelRatioWatcher = watchDevicePixelRatio(resize);
}
