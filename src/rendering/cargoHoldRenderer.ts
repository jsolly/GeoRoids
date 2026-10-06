import { cargoCapacity } from '../../shared/economy';
import type { Position, ShipKitId } from '../../shared-types';
import { PALETTE } from '../constants';
import type { Player } from '../entities/player/Player';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import type { DrawingContext } from './drawingContext';
import { resolveGlow } from './renderQuality';

const holdScreen = { x: 0, y: 0 };

/** Hull-local holds sit aft of the cockpit and clear of the equipped tool. */
const CARGO_BAYS: Record<
  ShipKitId,
  { forward: number; length: number; width: number; columns: number; rows: number }
> = {
  scout: { forward: -0.4, length: 0.3, width: 0.6, columns: 2, rows: 2 },
  hauler: { forward: -0.6, length: 0.4, width: 0.52, columns: 4, rows: 3 },
};

export function drawCargoHolds(players: readonly Player[], viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const scale = canvasManager.getPlayfieldScale();
  const rotation = canvasManager.getCameraRotation();
  const now = performance.now();
  for (const player of players) {
    if (
      player.ship.health <= 0 ||
      player.ship.exploding ||
      player.ship.furnaceTransit ||
      (player.ship.blinkCount > 0 && !player.ship.blinkOn)
    ) {
      continue;
    }
    canvasManager.worldToScreenInto(holdScreen, player.ship.position, viewer);
    drawCargoHoldArtwork(ctx, {
      position: holdScreen,
      radius: player.ship.r * scale,
      angle: player.ship.angle - rotation,
      kitId: player.ship.kitId,
      color: player.color,
      fraction: player.cargo / cargoCapacity(player.ship.kitId),
      now,
    });
  }
}

/** Cargo crates fill the ship's recessed bay from aft to fore as the hold fills. */
export function drawCargoHoldArtwork(
  ctx: DrawingContext,
  {
    position,
    radius,
    angle,
    kitId,
    color,
    fraction,
    now,
  }: {
    position: Position;
    radius: number;
    angle: number;
    kitId: ShipKitId;
    color: string;
    fraction: number;
    now: number;
  }
): void {
  const fill = Math.max(0, Math.min(1, fraction));
  const full = fill >= 1;
  const bay = CARGO_BAYS[kitId];
  const x = bay.forward * radius;
  const y = (-bay.width * radius) / 2;
  const width = bay.length * radius;
  const height = bay.width * radius;
  const inset = Math.min(0.6, width * 0.1);
  const gap = Math.min(0.8, width * 0.08);
  const cellWidth = (width - inset * 2 - gap * (bay.columns - 1)) / bay.columns;
  const cellHeight = (height - inset * 2 - gap * (bay.rows - 1)) / bay.rows;

  ctx.save();
  ctx.translate(position.x, position.y);
  // Match hullOutlines' +forward/-screen-y projection, including camera rotation.
  ctx.rotate(-angle);
  ctx.fillStyle = hexToRgba(PALETTE.BG, 0.95);
  ctx.fillRect(x, y, width, height);
  ctx.lineWidth = full ? 1 : 0.65;
  ctx.strokeStyle = full ? PALETTE.LOOT : hexToRgba(color, 0.7);
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = full ? resolveGlow(4 + 2 * Math.sin(now / 250)) : 0;
  ctx.strokeRect(x, y, width, height);
  ctx.shadowBlur = 0;
  for (let cell = 0; cell < bay.columns * bay.rows; cell++) {
    const column = Math.floor(cell / bay.rows);
    const row = cell % bay.rows;
    const cellX = x + inset + column * (cellWidth + gap);
    const cellY = y + inset + row * (cellHeight + gap);
    ctx.fillStyle = hexToRgba(color, 0.12);
    ctx.fillRect(cellX, cellY, cellWidth, cellHeight);
    const covered = Math.min(1, Math.max(0, fill * bay.columns * bay.rows - cell));
    if (covered > 0) {
      ctx.fillStyle = hexToRgba(PALETTE.LOOT, full ? 0.8 + 0.2 * Math.sin(now / 250) : 0.9);
      ctx.fillRect(cellX, cellY, cellWidth * covered, cellHeight);
    }
  }
  ctx.restore();
  if (full) {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 10px Arial';
    const text = 'CARGO FULL';
    const badgeWidth = ctx.measureText(text).width + 10;
    ctx.fillStyle = hexToRgba(PALETTE.BG, 0.9);
    ctx.fillRect(position.x - badgeWidth / 2, position.y + radius + 27, badgeWidth, 17);
    ctx.fillStyle = PALETTE.LOOT;
    ctx.fillText(text, position.x, position.y + radius + 29);
    ctx.restore();
  }
}
