import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { FURNACES } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getWorldExploration } from '../network/worldExploration';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';
import { resolveGlow } from './renderQuality';

const furnaceScreen = { x: 0, y: 0 };
const FURNACE_COLOR = PALETTE.SATELLITE;
const FURNACE_LABEL_COLOR = PALETTE.HUD;

/** Known station artwork; the ring marks a delivery zone and has no physics. */
export function drawFurnacesRelative(viewerPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const exploration = getWorldExploration();
  for (const furnace of FURNACES) {
    const cell = explorationCellAt(furnace.position);
    if (cell === null || !isCellExplored(exploration, cell)) {
      continue;
    }
    const screen = canvasManager.worldToScreenInto(furnaceScreen, furnace.position, viewerPosition);
    const radius = furnace.radius * scale;
    const cull = radius + 30;
    if (
      screen.x < -cull ||
      screen.y < -cull ||
      screen.x > viewport.width + cull ||
      screen.y > viewport.height + cull
    ) {
      continue;
    }
    drawFurnace(ctx, screen.x, screen.y, radius);
    drawFurnaceLabel(ctx, screen.x, screen.y, radius, furnace.name);
  }
}

function drawFurnace(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  const pulse = 0.78 + Math.sin(performance.now() / 850) * 0.12;
  const innerRadius = radius * 0.58;
  const hubRadius = Math.max(4, radius * 0.11);
  const line = Math.max(1, Math.min(2, radius * 0.018));

  ctx.save();
  ctx.fillStyle = hexToRgba(FURNACE_COLOR, 0.045);
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.3);
  ctx.shadowColor = FURNACE_COLOR;
  ctx.shadowBlur = resolveGlow(VISUAL.SHIP_GLOW * 1.4);
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Dashed perimeter makes the intake radius legible over the terrain.
  ctx.setLineDash([Math.max(4, radius * 0.1), Math.max(3, radius * 0.06)]);
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.75 * pulse);
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.88, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Four radial loading arms and a square furnace hub read as a station at a glance.
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.72);
  ctx.lineWidth = line;
  for (let index = 0; index < 4; index += 1) {
    const angle = index * (Math.PI / 2);
    const innerX = x + Math.cos(angle) * hubRadius * 1.4;
    const innerY = y + Math.sin(angle) * hubRadius * 1.4;
    const outerX = x + Math.cos(angle) * innerRadius;
    const outerY = y + Math.sin(angle) * innerRadius;
    ctx.beginPath();
    ctx.moveTo(innerX, innerY);
    ctx.lineTo(outerX, outerY);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(outerX, outerY, Math.max(2, radius * 0.045), 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = hexToRgba(FURNACE_COLOR, 0.2);
  ctx.strokeStyle = FURNACE_COLOR;
  ctx.beginPath();
  ctx.rect(x - hubRadius, y - hubRadius, hubRadius * 2, hubRadius * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2, radius * 0.035), 0, Math.PI * 2);
  ctx.fillStyle = FURNACE_COLOR;
  ctx.fill();
  ctx.restore();
}

function drawFurnaceLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  name: string
): void {
  ctx.save();
  ctx.fillStyle = hexToRgba(FURNACE_LABEL_COLOR, 0.82);
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(name, x, y - radius - 7);
  ctx.fillStyle = hexToRgba(FURNACE_COLOR, 0.72);
  ctx.font = '9px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('DELIVERY ZONE', x, y + radius + 7);
  ctx.restore();
}
