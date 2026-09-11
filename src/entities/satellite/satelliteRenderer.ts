import type { Position } from '../../../shared-types';
import { PALETTE, SATELLITE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import { PLAYFIELD_CLOSE_SCALE } from '../../rendering/playfieldCamera';
import { resolveGlow } from '../../rendering/renderQuality';
import { hexToRgba } from '../../utils/colorUtils';
import { drawLaserBolts } from '../ship/shipRenderer';
import { drawEoSatelliteOutline } from './eoOutlines';
import type { Satellite } from './Satellite';

export function drawSatellites(satellites: Satellite[], viewer: Position): void {
  for (const satellite of satellites) {
    drawSatellite(satellite, viewer);
    drawLaserBolts(satellite.lasers, PALETTE.LASER_ENEMY, viewer);
  }
}

function drawSatellite(satellite: Satellite, viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const screen = canvasManager.worldToScreen(satellite.position, viewer);
  const screenRadius = Math.max(5, satellite.radius * PLAYFIELD_CLOSE_SCALE);
  const color = satellite.color || PALETTE.SATELLITE;

  if (satellite.exploding) {
    drawSatelliteExplosion(ctx, screen.x, screen.y, screenRadius, satellite);
    return;
  }

  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(VISUAL.SHIP_GLOW);
  drawEoSatelliteOutline(
    ctx,
    satellite.typeId,
    screenRadius,
    satellite.angle,
    color,
    satellite.lasers.length > 0
  );
  ctx.restore();
  drawSatelliteHealth(ctx, screen.x, screen.y, screenRadius, satellite);
}

function drawSatelliteExplosion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  screenRadius: number,
  satellite: Satellite
): void {
  const t = 1 - satellite.explodeTime / SATELLITE.EXPLODE_DURATION_FRAMES;
  const alpha = 1 - t * 0.85;
  const spread = screenRadius * VISUAL.EXPLOSION_SPREAD_RATIO * t;
  const color = satellite.color || PALETTE.SATELLITE;
  const fragments = [
    { dx: -1, dy: -0.3, w: screenRadius * 1.1 },
    { dx: 1, dy: -0.2, w: screenRadius * 0.9 },
    { dx: 0, dy: -1, w: screenRadius * 0.6 },
    { dx: 0.2, dy: 0.8, w: screenRadius * 0.7 },
  ];

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(VISUAL.EXPLOSION_STROKE_WIDTH);
  ctx.lineWidth = VISUAL.EXPLOSION_STROKE_WIDTH;
  ctx.lineCap = 'butt';

  for (const fragment of fragments) {
    const cx = x + fragment.dx * spread;
    const cy = y + fragment.dy * spread;
    const spin = t * 0.8;
    const cos = Math.cos(spin);
    const sin = Math.sin(spin);
    const hx = (fragment.w / 2) * cos;
    const hy = (fragment.w / 2) * sin;
    ctx.beginPath();
    ctx.moveTo(cx - hx, cy - hy);
    ctx.lineTo(cx + hx, cy + hy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSatelliteHealth(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  screenRadius: number,
  satellite: Satellite
): void {
  if (satellite.health >= satellite.maxHealth) {
    return;
  }

  const barWidth = screenRadius * 2.4;
  const barY = screenY - screenRadius - 8;
  const barX = screenX - barWidth / 2;
  const healthPercent = Math.max(0, satellite.health / satellite.maxHealth);

  ctx.save();
  ctx.lineWidth = VISUAL.HEALTH_CAPSULE_HEIGHT;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.45);
  ctx.beginPath();
  ctx.moveTo(barX, barY);
  ctx.lineTo(barX + barWidth, barY);
  ctx.stroke();
  if (healthPercent > 0) {
    ctx.strokeStyle = PALETTE.HEALTH;
    ctx.beginPath();
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + barWidth * healthPercent, barY);
    ctx.stroke();
  }
  ctx.restore();
}
