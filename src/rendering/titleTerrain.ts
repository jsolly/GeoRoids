import { PALETTE, VISUAL } from '../constants';
import { extractIsoContours } from '../physics/terrain/contours';
import { createHeightfield } from '../physics/terrain/heightfield';
import { TERRAIN } from '../physics/terrain/terrainConfig';
import { hexToRgba } from '../utils/colorUtils';
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

  const contours = extractIsoContours(
    createHeightfield(TERRAIN.DEFAULT_SEED, { radius: 3100 }),
    180
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
    const scale = Math.max(width, height) / 4200;
    ctx.lineCap = 'round';
    for (const level of contours) {
      const isIndex = level.index % VISUAL.CONTOUR_INDEX_EVERY === 0;
      ctx.strokeStyle = hexToRgba(PALETTE.CONTOUR, isIndex ? 0.85 : 0.48);
      ctx.lineWidth = isIndex ? 1.4 : 0.8;
      ctx.beginPath();
      for (const segment of level.segments) {
        ctx.moveTo(width / 2 + segment.ax * scale, height / 2 + segment.ay * scale);
        ctx.lineTo(width / 2 + segment.bx * scale, height / 2 + segment.by * scale);
      }
      ctx.stroke();
    }

    // Labels interrupt the contours like a printed topo map. Heights are relative,
    // unitless terrain values, matching the field used by the game.
    const labels: { x: number; y: number }[] = [];
    ctx.font = '11px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const level of contours) {
      for (const segment of level.segments) {
        const x = width / 2 + ((segment.ax + segment.bx) / 2) * scale;
        const y = height / 2 + ((segment.ay + segment.by) / 2) * scale;
        if (x < 32 || x > width - 32 || y < 32 || y > height - 32) {
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
          labels.some((label) => Math.hypot(label.x - x, label.y - y) < 180)
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
          -ctx.measureText(elevation).width / 2 - 4,
          -7,
          ctx.measureText(elevation).width + 8,
          14
        );
        ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.75);
        ctx.fillText(elevation, 0, 0);
        ctx.restore();
      }
    }
  };

  resize();
  window.addEventListener('resize', resize);
  stopResizeListener = (): void => {
    window.removeEventListener('resize', resize);
  };
  stopDevicePixelRatioWatcher = watchDevicePixelRatio(resize);
}
