import { cargoCapacity } from '../../shared/economy';
import type { Position } from '../../shared-types';
import { PALETTE } from '../constants';
import type { Player } from '../entities/player/Player';
import { worldFurnaces } from '../network/worldExploration';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import type { DrawingContext } from './drawingContext';
import { resolveGlow } from './renderQuality';

interface OffloadVisual {
  furnaceId: string;
  initialCargo: number;
  cargo: number;
  bankedCargo: number;
  acceptedAt: number;
  acceptedPoints: number;
  completedAt: number;
}
const visuals = new WeakMap<Player, OffloadVisual>();
const shipScreen = { x: 0, y: 0 };
const furnaceScreen = { x: 0, y: 0 };

/** Presentation follows cargo and bank snapshots; it never awards points locally. */
export function drawCargoOffloads(players: readonly Player[], viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const now = performance.now();
  const scale = canvasManager.getPlayfieldScale();
  for (const player of players) {
    const ship = player.ship;
    if (ship.health <= 0 || ship.exploding || ship.furnaceTransit) {
      visuals.delete(player);
      continue;
    }
    let visual = visuals.get(player);
    if (player.cargo <= 0 && !visual) {
      continue;
    }
    const furnace = worldFurnaces.intakeAt(ship.position, ship.r);
    if (!furnace) {
      visuals.delete(player);
      continue;
    }
    if (visual && visual.furnaceId !== furnace.id) {
      visuals.delete(player);
      visual = undefined;
    }
    if (!visual && player.cargo > 0) {
      visual = {
        furnaceId: furnace.id,
        initialCargo: player.cargo,
        cargo: player.cargo,
        bankedCargo: player.bankedCargo,
        acceptedAt: -Infinity,
        acceptedPoints: 0,
        completedAt: -Infinity,
      };
      visuals.set(player, visual);
    }
    if (!visual) {
      continue;
    }
    const transferred = player.bankedCargo - visual.bankedCargo;
    if (transferred > 0) {
      visual.acceptedAt = now;
      visual.acceptedPoints = transferred;
      if (player.cargo === 0 && transferred >= visual.cargo) {
        visual.completedAt = now;
      }
    }
    visual.initialCargo = Math.max(visual.initialCargo, player.cargo);
    visual.cargo = player.cargo;
    visual.bankedCargo = player.bankedCargo;
    canvasManager.worldToScreenInto(shipScreen, ship.position, viewer);
    canvasManager.worldToScreenInto(furnaceScreen, furnace.position, viewer);
    const completionAge = now - visual.completedAt;
    if (player.cargo === 0 && completionAge > 900) {
      visuals.delete(player);
      continue;
    }
    drawCargoOffloadArtwork(ctx, {
      ship: shipScreen,
      furnace: furnaceScreen,
      radius: furnace.radius * scale,
      remaining: player.cargo,
      fraction: player.cargo / visual.initialCargo,
      now,
      pulse: Math.max(0, 1 - (now - visual.acceptedAt) / 300),
      acceptedPoints: visual.acceptedPoints,
      completionAge,
      local: player.type === 'local',
      capacity: cargoCapacity(ship.kitId),
    });
  }
}

/** Bounded vector particles and a progress ring keep each transfer readable over the fire. */
export function drawCargoOffloadArtwork(
  ctx: DrawingContext,
  frame: {
    ship: Position;
    furnace: Position;
    radius: number;
    remaining: number;
    fraction: number;
    now: number;
    pulse: number;
    acceptedPoints: number;
    completionAge: number;
    local: boolean;
    capacity: number;
  }
): void {
  const { ship, furnace, radius, now, pulse, remaining, completionAge } = frame;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.fillStyle = PALETTE.LOOT;
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = resolveGlow(10);
  const complete = remaining === 0;
  if (complete) {
    const t = Math.min(1, completionAge / 900);
    ctx.globalAlpha = 1 - t;
    ctx.lineWidth = 3 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(furnace.x, furnace.y, radius + 8 + t * 38, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.lineWidth = 2 + pulse * 2;
    ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 0.22 + pulse * 0.25);
    ctx.beginPath();
    ctx.arc(furnace.x, furnace.y, radius + 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    ctx.arc(
      furnace.x,
      furnace.y,
      radius + 7,
      -Math.PI / 2,
      -Math.PI / 2 + (1 - frame.fraction) * Math.PI * 2
    );
    ctx.stroke();
    // Two curved streams remain visible even when the pilot sits at the grate's center.
    for (const side of [-1, 1]) {
      const start = { x: ship.x + side * 12, y: ship.y + 9 };
      const control = {
        x: (ship.x + furnace.x) / 2 + side * 42,
        y: Math.max(ship.y, furnace.y) + 40,
      };
      const end = { x: furnace.x + side * radius * 0.25, y: furnace.y + radius * 0.4 };
      ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 0.25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
      ctx.stroke();
      for (let index = 0; index < 6; index++) {
        const t = (now / 650 + index / 6) % 1;
        const u = 1 - t;
        const x = u * u * start.x + 2 * u * t * control.x + t * t * end.x;
        const y = u * u * start.y + 2 * u * t * control.y + t * t * end.y;
        ctx.globalAlpha = 0.45 + Math.sin(t * Math.PI) * 0.55;
        ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    }
  }
  ctx.globalAlpha = complete ? 1 - Math.min(1, completionAge / 900) : 1;
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 11px Arial';
  const y = ship.y + 30;
  const label = complete ? 'CARGO BANKED' : `OFFLOADING · ${remaining} LEFT`;
  const width = ctx.measureText(label).width + 16;
  ctx.fillStyle = hexToRgba(PALETTE.BG, 0.9);
  ctx.fillRect(ship.x - width / 2, y - 4, width, 23);
  ctx.fillStyle = PALETTE.LOOT;
  ctx.fillText(label, ship.x, y);
  if (!complete) {
    ctx.fillStyle = hexToRgba(PALETTE.LOOT, 0.2);
    ctx.fillRect(ship.x - 40, y + 14, 80, 3);
    ctx.fillStyle = PALETTE.LOOT;
    ctx.fillRect(ship.x - 40, y + 14, 80 * Math.min(1, remaining / frame.capacity), 3);
  }
  if (frame.local && pulse > 0) {
    ctx.globalAlpha = pulse;
    ctx.font = 'bold 14px Arial';
    ctx.fillStyle = PALETTE.LOOT;
    ctx.fillText(`+${frame.acceptedPoints}`, furnace.x, furnace.y - radius - 42 - (1 - pulse) * 12);
  }
  ctx.restore();
}
