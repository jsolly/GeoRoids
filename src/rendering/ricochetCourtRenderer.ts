import { WIRE_PALETTE } from '../../shared/constants/gameplay';
import { COURT_REFLECTORS, RICOCHET_COURT } from '../../shared/ricochetCourt';
import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import { PLAYFIELD_CLOSE_SCALE } from './playfieldCamera';
import { discardRasterSurface, prepareRasterSurface, type RasterSurface } from './rasterSurface';
import { resolveGlow } from './renderQuality';

const courtScreen = { x: 0, y: 0 };
const MAX_STATIC_COURT_PIXELS = 2_000_000;
const MAX_STATIC_COURT_DIMENSION = 1536;
const COURT_PANELS = COURT_REFLECTORS.map(({ start, end }) => ({
  startX: start.x - RICOCHET_COURT.center.x,
  startY: start.y - RICOCHET_COURT.center.y,
  endX: end.x - RICOCHET_COURT.center.x,
  endY: end.y - RICOCHET_COURT.center.y,
}));
const COURT_ART_EXTENT =
  Math.max(
    ...COURT_REFLECTORS.flatMap(({ start, end }) => [
      Math.abs(start.x - RICOCHET_COURT.center.x),
      Math.abs(start.y - RICOCHET_COURT.center.y),
      Math.abs(end.x - RICOCHET_COURT.center.x),
      Math.abs(end.y - RICOCHET_COURT.center.y),
    ])
  ) + 7;
let staticCourtArtwork: {
  surface: RasterSurface;
  dpr: number;
  glow: number;
} | null = null;

export function clearStaticCourtArtwork(): void {
  if (staticCourtArtwork) {
    discardRasterSurface(staticCourtArtwork.surface);
    staticCourtArtwork = null;
  }
}

/** Open corners, rather than a closed boundary, identify the fly-through court on maps. */
export function drawCourtMapMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number
): void {
  ctx.save();
  ctx.translate(x, y);
  const scale = radius / RICOCHET_COURT.radius;
  ctx.strokeStyle = WIRE_PALETTE.REMOTE;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const reflector of COURT_REFLECTORS) {
    ctx.moveTo(
      (reflector.start.x - RICOCHET_COURT.center.x) * scale,
      (reflector.start.y - RICOCHET_COURT.center.y) * scale
    );
    ctx.lineTo(
      (reflector.end.x - RICOCHET_COURT.center.x) * scale,
      (reflector.end.y - RICOCHET_COURT.center.y) * scale
    );
  }
  ctx.stroke();
  ctx.restore();
}

export function drawRicochetCourt(viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const viewport = canvasManager.getViewportSize();
  const center = canvasManager.worldToScreenInto(courtScreen, RICOCHET_COURT.center, viewer);
  const radius = RICOCHET_COURT.radius * PLAYFIELD_CLOSE_SCALE + 40;
  if (
    center.x + radius < 0 ||
    center.x - radius > viewport.width ||
    center.y + radius < 0 ||
    center.y - radius > viewport.height
  ) {
    return;
  }
  ctx.save();
  try {
    ctx.translate(center.x, center.y);
    ctx.scale(PLAYFIELD_CLOSE_SCALE, PLAYFIELD_CLOSE_SCALE);
    const haloPainted = drawStaticCourtHalo(ctx);
    paintCourtPanels(ctx, haloPainted ? 0 : resolveGlow(8));
    // Text stays vector-painted at the current subpixel camera position.
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px "Courier New", monospace';
    ctx.fillStyle = hexToRgba(WIRE_PALETTE.REMOTE, 0.55);
    ctx.fillText(RICOCHET_COURT.name.toUpperCase(), 0, -100);
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = hexToRgba(PALETTE.HUD, 0.4);
    ctx.fillText('BANK SHOTS • FLY THROUGH', 0, -80);
  } finally {
    ctx.restore();
  }
}

function drawStaticCourtHalo(ctx: CanvasRenderingContext2D): boolean {
  if (!canvasManager.isFlightView()) {
    return false;
  }
  const glow = resolveGlow(8);
  if (glow === 0) {
    clearStaticCourtArtwork();
    return false;
  }
  const dpr = canvasManager.getRasterPixelRatio(ctx, glow);
  const half = Math.ceil(COURT_ART_EXTENT * dpr + 3 * glow + 2);
  const side = half * 2;
  if (side > MAX_STATIC_COURT_DIMENSION || side * side > MAX_STATIC_COURT_PIXELS) {
    return false;
  }
  let art = staticCourtArtwork;
  if (!art || art.dpr !== dpr || art.glow !== glow || art.surface.context.isContextLost?.()) {
    clearStaticCourtArtwork();
    const surface = prepareRasterSurface(side, side, undefined, 'Court artwork canvas unavailable');
    try {
      surface.context.setTransform(dpr, 0, 0, dpr, half, half);
      // Put source strokes outside the bitmap, retaining only their shadows.
      // Crisp beams and emitters still use the live subpixel camera transform.
      surface.context.translate((side * 2) / dpr, 0);
      surface.context.shadowOffsetX = -side * 2;
      surface.context.shadowColor = WIRE_PALETTE.REMOTE;
      surface.context.shadowBlur = glow;
      surface.context.strokeStyle = hexToRgba(WIRE_PALETTE.REMOTE, 0.75);
      surface.context.lineWidth = 1.5;
      surface.context.lineCap = 'round';
      surface.context.setLineDash([10, 5]);
      for (const panel of COURT_PANELS) {
        traceCourtPanel(surface.context, panel);
        surface.context.stroke();
      }
      art = { surface, dpr, glow };
      staticCourtArtwork = art;
    } catch (error) {
      discardRasterSurface(surface);
      throw error;
    }
  }
  ctx.save();
  try {
    ctx.shadowBlur = 0;
    ctx.drawImage(art.surface.canvas, -half / dpr, -half / dpr, side / dpr, side / dpr);
  } finally {
    ctx.restore();
  }
  return true;
}

function traceCourtPanel(
  ctx: CanvasRenderingContext2D,
  panel: (typeof COURT_PANELS)[number]
): void {
  ctx.beginPath();
  ctx.moveTo(panel.startX, panel.startY);
  ctx.lineTo(panel.endX, panel.endY);
}

function paintCourtPanels(ctx: CanvasRenderingContext2D, glow: number): void {
  ctx.lineCap = 'round';
  for (const panel of COURT_PANELS) {
    const { startX, startY, endX, endY } = panel;
    traceCourtPanel(ctx, panel);
    ctx.strokeStyle = hexToRgba(WIRE_PALETTE.REMOTE, 0.09);
    ctx.lineWidth = 14;
    ctx.stroke();
    ctx.strokeStyle = hexToRgba(WIRE_PALETTE.REMOTE, 0.75);
    ctx.shadowColor = WIRE_PALETTE.REMOTE;
    ctx.shadowBlur = glow;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    // Hollow emitters and a broken beam keep the fields distinct from solid terrain.
    ctx.beginPath();
    ctx.arc(startX, startY, 3, 0, Math.PI * 2);
    ctx.moveTo(endX + 3, endY);
    ctx.arc(endX, endY, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}
