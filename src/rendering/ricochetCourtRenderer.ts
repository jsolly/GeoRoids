import { COURT_REFLECTORS, RICOCHET_COURT } from '../../shared/ricochetCourt';
import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import { PLAYFIELD_CLOSE_SCALE } from './playfieldCamera';
import { resolveGlow } from './renderQuality';

const courtScreen = { x: 0, y: 0 };

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
  ctx.strokeStyle = PALETTE.REMOTE;
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
  ctx.translate(center.x, center.y);
  ctx.scale(PLAYFIELD_CLOSE_SCALE, PLAYFIELD_CLOSE_SCALE);
  ctx.lineCap = 'round';
  for (const reflector of COURT_REFLECTORS) {
    const startX = reflector.start.x - RICOCHET_COURT.center.x;
    const startY = reflector.start.y - RICOCHET_COURT.center.y;
    const endX = reflector.end.x - RICOCHET_COURT.center.x;
    const endY = reflector.end.y - RICOCHET_COURT.center.y;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = hexToRgba(PALETTE.REMOTE, 0.09);
    ctx.lineWidth = 14;
    ctx.stroke();
    ctx.strokeStyle = hexToRgba(PALETTE.REMOTE, 0.75);
    ctx.shadowColor = PALETTE.REMOTE;
    ctx.shadowBlur = resolveGlow(8);
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '12px "Courier New", monospace';
  ctx.fillStyle = hexToRgba(PALETTE.REMOTE, 0.55);
  ctx.fillText(RICOCHET_COURT.name.toUpperCase(), 0, -100);
  ctx.font = '10px "Courier New", monospace';
  ctx.fillStyle = hexToRgba(PALETTE.HUD, 0.4);
  ctx.fillText('BANK SHOTS • FLY THROUGH', 0, -80);
  ctx.restore();
}
