import { PALETTE, VISUAL } from '../constants';
import type { ContourLevel } from '../physics/terrain/contours';
import { hexToRgba } from '../utils/colorUtils';
import type { DrawingContext } from './drawingContext';
import { projectWorldToScreenInto } from './playfieldCamera';

interface ElevationLabel {
  x: number;
  y: number;
  angle: number;
  text: string;
}

const labelCache = new WeakMap<readonly ContourLevel[], Map<number, ElevationLabel[]>>();
const widthCache = new WeakMap<
  DrawingContext,
  { levels: readonly ContourLevel[]; font: string; widths: Map<string, number> }
>();

function cellKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

/**
 * Place readable elevation marks without scanning every already-accepted label
 * for each contour segment. A linear scan hitch rebuilt the whole field every
 * time the ship entered a new terrain patch.
 */
export function collectElevationLabels(
  levels: readonly ContourLevel[],
  spacing: number
): ElevationLabel[] {
  if (!Number.isFinite(spacing) || spacing <= 0) {
    return [];
  }
  const labels: ElevationLabel[] = [];
  const buckets = new Map<string, ElevationLabel[]>();
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
      if (Math.abs(angle) > Math.PI / 3) {
        continue;
      }
      const ix = Math.floor(x / spacing);
      const iy = Math.floor(y / spacing);
      let tooClose = false;
      for (let dx = -1; dx <= 1 && !tooClose; dx++) {
        for (let dy = -1; dy <= 1 && !tooClose; dy++) {
          const bucket = buckets.get(cellKey(ix + dx, iy + dy));
          if (!bucket) {
            continue;
          }
          for (const label of bucket) {
            if (Math.hypot(label.x - x, label.y - y) < spacing) {
              tooClose = true;
              break;
            }
          }
        }
      }
      if (tooClose) {
        continue;
      }
      // Elevation is relative and unitless, as in the shared heightfield.
      const label: ElevationLabel = {
        x,
        y,
        angle,
        text: level.height.toFixed(Math.abs(level.height) < 0.01 ? 4 : 2),
      };
      labels.push(label);
      const key = cellKey(ix, iy);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(label);
      } else {
        buckets.set(key, [label]);
      }
    }
  }
  return labels;
}

/** Select anchors once in world space so labels never swim as the camera moves. */
function getLabels(levels: readonly ContourLevel[], spacing: number): ElevationLabel[] {
  const cached = labelCache.get(levels)?.get(spacing);
  if (cached) {
    return cached;
  }
  const labels = collectElevationLabels(levels, spacing);
  const variants = labelCache.get(levels) ?? new Map<number, ElevationLabel[]>();
  variants.set(spacing, labels);
  labelCache.set(levels, variants);
  return labels;
}

/** Fill the per-patch label cache off the crossing frame. */
export function warmElevationLabels(
  levels: readonly ContourLevel[],
  spacing: number = VISUAL.CONTOUR_LABEL_SPACING
): void {
  getLabels(levels, spacing);
}

/** Test helper: true when this contour set already has spaced labels. */
export function elevationLabelsAreCached(
  levels: readonly ContourLevel[],
  spacing: number = VISUAL.CONTOUR_LABEL_SPACING
): boolean {
  return labelCache.get(levels)?.has(spacing) === true;
}

export function drawContourLabels(
  ctx: DrawingContext,
  levels: readonly ContourLevel[],
  view: {
    width: number;
    height: number;
    x: number;
    y: number;
    scale: number;
    rotation?: number;
    alpha: number;
    spacing: number;
  }
): void {
  ctx.save();
  ctx.font = VISUAL.CONTOUR_LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let metrics = widthCache.get(ctx);
  if (!metrics || metrics.levels !== levels || metrics.font !== ctx.font) {
    // Keep only this terrain's fixed-font labels for each drawing context.
    metrics = { levels, font: ctx.font, widths: new Map() };
    widthCache.set(ctx, metrics);
  }
  const screen = { x: 0, y: 0 };
  for (const label of getLabels(levels, view.spacing)) {
    const { x, y } = projectWorldToScreenInto(
      screen,
      label,
      view,
      view,
      view.scale,
      view.rotation ?? 0
    );
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
    const angle = label.angle + (view.rotation ?? 0);
    ctx.rotate(Math.atan(Math.tan(angle)));
    let textWidth = metrics.widths.get(label.text);
    if (textWidth === undefined) {
      textWidth = ctx.measureText(label.text).width;
      metrics.widths.set(label.text, textWidth);
    }
    const width = textWidth + VISUAL.CONTOUR_LABEL_PADDING * 2;
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(-width / 2, -VISUAL.CONTOUR_LABEL_HEIGHT / 2, width, VISUAL.CONTOUR_LABEL_HEIGHT);
    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, view.alpha);
    ctx.fillText(label.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}
