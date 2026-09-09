import { PALETTE, VISUAL } from '../constants';
import type { ContourLevel } from '../physics/terrain/contours';
import { hexToRgba } from '../utils/colorUtils';

interface ElevationLabel {
  x: number;
  y: number;
  angle: number;
  text: string;
}

const labelCache = new WeakMap<readonly ContourLevel[], Map<number, ElevationLabel[]>>();

/** Select anchors once in world space so labels never swim as the camera moves. */
function getLabels(levels: readonly ContourLevel[], spacing: number): ElevationLabel[] {
  const cached = labelCache.get(levels)?.get(spacing);
  if (cached) {
    return cached;
  }
  const labels: ElevationLabel[] = [];
  for (const level of levels) {
    for (const segment of level.segments) {
      const x = (segment.ax + segment.bx) / 2;
      const y = (segment.ay + segment.by) / 2;
      let angle = Math.atan2(segment.by - segment.ay, segment.bx - segment.ax);
      if (angle > Math.PI / 2) {
        angle -= Math.PI;
      } else if (angle < -Math.PI / 2) {
        angle += Math.PI;
      }
      if (
        Math.abs(angle) > Math.PI / 3 ||
        labels.some((label) => Math.hypot(label.x - x, label.y - y) < spacing)
      ) {
        continue;
      }
      // Elevation is relative and unitless, as in the shared heightfield.
      labels.push({ x, y, angle, text: level.height.toFixed(2) });
    }
  }
  const variants = labelCache.get(levels) ?? new Map<number, ElevationLabel[]>();
  variants.set(spacing, labels);
  labelCache.set(levels, variants);
  return labels;
}

export function drawContourLabels(
  ctx: CanvasRenderingContext2D,
  levels: readonly ContourLevel[],
  view: {
    width: number;
    height: number;
    x: number;
    y: number;
    scale: number;
    alpha: number;
    spacing: number;
  }
): void {
  ctx.save();
  ctx.font = VISUAL.CONTOUR_LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const label of getLabels(levels, view.spacing)) {
    const x = view.width / 2 + (label.x - view.x) * view.scale;
    const y = view.height / 2 + (label.y - view.y) * view.scale;
    if (
      x < VISUAL.CONTOUR_LABEL_MARGIN_X ||
      x > view.width - VISUAL.CONTOUR_LABEL_MARGIN_X ||
      y < VISUAL.CONTOUR_LABEL_MARGIN_Y ||
      y > view.height - VISUAL.CONTOUR_LABEL_MARGIN_Y
    ) {
      continue;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(label.angle);
    const width = ctx.measureText(label.text).width + VISUAL.CONTOUR_LABEL_PADDING * 2;
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(-width / 2, -VISUAL.CONTOUR_LABEL_HEIGHT / 2, width, VISUAL.CONTOUR_LABEL_HEIGHT);
    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, view.alpha);
    ctx.fillText(label.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}
