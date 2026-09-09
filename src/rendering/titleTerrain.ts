import { PALETTE, VISUAL } from '../constants';
import { getGameBoundary } from '../physics/boundary';
import { extractIsoContours } from '../physics/terrain/contours';
import { createHeightfield } from '../physics/terrain/heightfield';
import { TERRAIN } from '../physics/terrain/terrainConfig';
import { hexToRgba } from '../utils/colorUtils';

/** A fixed terrain preview, independent of the live room's terrain cache. */
export function initTitleTerrain(): void {
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
    VISUAL.TITLE_TERRAIN_GRID_SIZE
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

    // Labels interrupt the contours like a printed topo map. Heights are relative,
    // unitless terrain values, matching the field used by the game.
    const labels: { x: number; y: number }[] = [];
    ctx.font = VISUAL.TITLE_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const level of contours) {
      for (const segment of level.segments) {
        const x = width / 2 + ((segment.ax + segment.bx) / 2 - bounds.cx) * scale;
        const y = height / 2 + ((segment.ay + segment.by) / 2 - bounds.cy) * scale;
        if (
          x < VISUAL.TITLE_LABEL_MARGIN ||
          x > width - VISUAL.TITLE_LABEL_MARGIN ||
          y < VISUAL.TITLE_LABEL_MARGIN ||
          y > height - VISUAL.TITLE_LABEL_MARGIN
        ) {
          continue;
        }
        let angle = Math.atan2(segment.by - segment.ay, segment.bx - segment.ax);
        if (angle > Math.PI / 2) {
          angle -= Math.PI;
        } else if (angle < -Math.PI / 2) {
          angle += Math.PI;
        }
        if (
          Math.abs(angle) > Math.PI / 3 ||
          labels.some((label) => Math.hypot(label.x - x, label.y - y) < VISUAL.TITLE_LABEL_SPACING)
        ) {
          continue;
        }
        labels.push({ x, y });
        const elevation = level.height.toFixed(2);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = PALETTE.BG;
        ctx.fillRect(
          -ctx.measureText(elevation).width / 2 - VISUAL.TITLE_LABEL_PADDING,
          -VISUAL.TITLE_LABEL_HEIGHT / 2,
          ctx.measureText(elevation).width + VISUAL.TITLE_LABEL_PADDING * 2,
          VISUAL.TITLE_LABEL_HEIGHT
        );
        ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, VISUAL.TITLE_LABEL_ALPHA);
        ctx.fillText(elevation, 0, 0);
        ctx.restore();
      }
    }
  };

  resize();
  window.addEventListener('resize', resize);
}
