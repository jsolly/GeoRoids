import type { LootData, LootKind } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import { PLAYFIELD_CLOSE_SCALE } from '../../rendering/playfieldCamera';
import { resolveGlow } from '../../rendering/renderQuality';
import { hexToRgba } from '../../utils/colorUtils';
import type { Ship } from '../ship/Ship';
import { LootField } from './LootField';

export function lootStrokeColor(kind: LootKind): string {
  if (kind === 'laserCore') {
    return PALETTE.LASER_LOCAL;
  }
  if (kind === 'fuel') {
    return PALETTE.HEALTH;
  }
  return PALETTE.LOOT;
}

/** Positive screen-space pickup radius; malformed snapshots are ignored. */
export function lootScreenRadius(worldRadius: number, scale: number): number | null {
  if (!Number.isFinite(worldRadius) || worldRadius <= 0 || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const scaled = worldRadius * scale;
  if (!Number.isFinite(scaled) || scaled <= 0) {
    return null;
  }
  return Math.max(VISUAL.LOOT_MIN_SCREEN_PX, scaled);
}

function traceDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

/** Cream diamond pickups — void understroke so they read on slate contours. */
export function drawLootRelative(ship: Ship, loot: readonly LootData[]): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const scale = PLAYFIELD_CLOSE_SCALE;
  const blast = LootField.getInstance().getBlast();
  if (blast) {
    const screen = canvasManager.worldToScreen(blast.position, ship.position);
    const r = lootScreenRadius(blast.radius, scale);
    if (Number.isFinite(screen.x) && Number.isFinite(screen.y) && r !== null) {
      ctx.save();
      ctx.lineWidth = VISUAL.LOOT_STROKE_WIDTH;
      ctx.strokeStyle = PALETTE.DANGER;
      ctx.shadowColor = PALETTE.DANGER;
      ctx.shadowBlur = resolveGlow(VISUAL.LOOT_GLOW);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (loot.length === 0) {
    return;
  }

  for (const drop of loot) {
    const screen = canvasManager.worldToScreen(drop.position, ship.position);
    const r = lootScreenRadius(drop.radius, scale);
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y) || r === null) {
      continue;
    }

    const isCore = drop.kind === 'laserCore';
    const isFuel = drop.kind === 'fuel';
    const isShard = drop.kind === 'shard';
    const isDenseShard = isShard && Number.isFinite(drop.mass) && drop.mass >= 0.5;
    const color = lootStrokeColor(drop.kind);
    const trace = (): void => {
      ctx.beginPath();
      if (isFuel) {
        ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
        ctx.moveTo(screen.x, screen.y - r * 0.45);
        ctx.lineTo(screen.x, screen.y + r * 0.45);
        ctx.moveTo(screen.x - r * 0.45, screen.y);
        ctx.lineTo(screen.x + r * 0.45, screen.y);
        return;
      }
      traceDiamond(ctx, screen.x, screen.y, r);
      if (isCore) {
        ctx.moveTo(screen.x - r * 0.45, screen.y + r * 0.3);
        ctx.lineTo(screen.x + r * 0.1, screen.y - r * 0.55);
        ctx.lineTo(screen.x - r * 0.1, screen.y + r * 0.55);
        ctx.lineTo(screen.x + r * 0.45, screen.y - r * 0.3);
      }
      if (isShard) {
        traceDiamond(ctx, screen.x, screen.y, r * VISUAL.LOOT_SHARD_INNER);
        if (isDenseShard) {
          traceDiamond(ctx, screen.x, screen.y, r * VISUAL.LOOT_SHARD_DENSE_INNER);
        }
      }
    };

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = 0;
    ctx.lineWidth = VISUAL.LOOT_UNDERSTROKE;
    ctx.strokeStyle = PALETTE.BG;
    trace();
    ctx.stroke();
    ctx.lineWidth = VISUAL.LOOT_STROKE_WIDTH;
    ctx.shadowColor = color;
    ctx.shadowBlur = resolveGlow(VISUAL.LOOT_GLOW);
    ctx.strokeStyle = hexToRgba(color, 0.55);
    trace();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    trace();
    ctx.stroke();
    ctx.restore();
  }
}
