import { WORLD_BOUNDARY } from '../../shared/boundary';
import { createHeightfield } from '../../shared/heightfield';
import { TERRAIN } from '../../shared/terrainConfig';
import { PALETTE, VISUAL } from '../constants';
import { extractIsoContours } from '../physics/terrain/contours';
import { hexToRgba } from '../utils/colorUtils';
import { releaseBitmap, resizeBitmap } from './bitmapBudget';
import { watchDevicePixelRatio } from './devicePixelRatioWatcher';

/** A fixed terrain preview, independent of the live room's terrain cache. */
export function initTitleTerrain(canvas: HTMLCanvasElement): () => void {
  // No default backing allocation survives a failed initial context or terrain build.
  releaseBitmap(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    releaseBitmap(canvas);
    return () => {};
  }

  // The live world can span tens of thousands of units. The title is a local
  // composition, so sample a compact preview window instead of extracting the
  // entire world and cropping its lines down to nothing.
  const worldBounds = WORLD_BOUNDARY;
  const bounds = {
    cx: worldBounds.cx,
    cy: worldBounds.cy,
    radius: Math.min(3100, worldBounds.radius),
  };
  const contours = extractIsoContours(
    createHeightfield(TERRAIN.DEFAULT_SEED, bounds),
    VISUAL.TITLE_TERRAIN_GRID_SIZE,
    VISUAL.TITLE_TERRAIN_INTERVAL
  );
  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    resizeBitmap(canvas, Math.round(width * dpr), Math.round(height * dpr), 'title');
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
  };

  let stopDpr: (() => void) | undefined;
  try {
    resize();
    window.addEventListener('resize', resize);
    stopDpr = watchDevicePixelRatio(resize);
  } catch (error) {
    window.removeEventListener('resize', resize);
    stopDpr?.();
    releaseBitmap(canvas);
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    window.removeEventListener('resize', resize);
    stopDpr?.();
    releaseBitmap(canvas);
  };
}
