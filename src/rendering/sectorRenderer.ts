import { formatSectorLabel, sectorBounds } from '../../shared/sectors';
import { parseSectorId, sectorAt } from '../../shared/world';
import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getCompletedSectors } from '../network/worldExploration';
import { hexToRgba } from '../utils/colorUtils';
import { logger } from '../utils/Logger';
import { canvasManager } from './canvas';
import { PLAYFIELD_CLOSE_SCALE } from './playfieldCamera';

const NEIGHBOR_RANGE = 1;

function screenRect(
  shipPosition: Position,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): { x: number; y: number; width: number; height: number } {
  const topLeft = canvasManager.worldToScreen({ x: minX, y: minY }, shipPosition);
  const bottomRight = canvasManager.worldToScreen({ x: maxX, y: maxY }, shipPosition);
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };
}

/** Current sector grid plus completed-sector walls that nearby ships cannot cross. */
export function drawSectorBoundaries(shipPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    logger.warn('SECTOR_RENDERER', 'Canvas or context not available');
    return;
  }

  const current = sectorAt(shipPosition);
  const completed = getCompletedSectors();
  ctx.save();
  ctx.lineJoin = 'miter';

  for (let y = current.y - NEIGHBOR_RANGE; y <= current.y + NEIGHBOR_RANGE; y++) {
    for (let x = current.x - NEIGHBOR_RANGE; x <= current.x + NEIGHBOR_RANGE; x++) {
      const bounds = sectorBounds(x, y);
      const rect = screenRect(shipPosition, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
      const isCurrent = x === current.x && y === current.y;
      ctx.strokeStyle = hexToRgba(PALETTE.HUD, isCurrent ? 0.28 : 0.12);
      ctx.lineWidth = isCurrent ? VISUAL.BOUNDARY_STROKE_WIDTH : 1;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      if (isCurrent) {
        ctx.fillStyle = hexToRgba(PALETTE.HUD, 0.55);
        ctx.font = `${Math.max(10, 11 * PLAYFIELD_CLOSE_SCALE)}px "Courier New", monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`SECTOR ${formatSectorLabel(current)}`, rect.x + 8, rect.y + 8);
      }
    }
  }

  for (const id of completed) {
    const parsed = parseSectorId(id);
    if (!parsed) {
      continue;
    }
    if (
      Math.abs(parsed.x - current.x) > NEIGHBOR_RANGE + 1 ||
      Math.abs(parsed.y - current.y) > NEIGHBOR_RANGE + 1
    ) {
      continue;
    }
    const bounds = sectorBounds(parsed.x, parsed.y);
    const rect = screenRect(shipPosition, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    ctx.fillStyle = hexToRgba(PALETTE.DANGER, 0.12);
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = hexToRgba(PALETTE.DANGER, 0.85);
    ctx.lineWidth = VISUAL.BOUNDARY_STROKE_WIDTH + 1;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }

  ctx.restore();
}
