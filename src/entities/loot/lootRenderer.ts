import { EQUIPMENT, isEquipmentId } from '../../../shared/equipment';
import type { LootData } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvasSurface';
import { addResourceMapPath } from '../../rendering/hud/resourceMapMark';
import { PLAYFIELD_CLOSE_SCALE } from '../../rendering/playfieldCamera';
import { resolveGlow } from '../../rendering/renderQuality';
import { hexToRgba } from '../../utils/colorUtils';
import type { Ship } from '../ship/Ship';
import { LootField } from './LootField';

/** Outline canister / tap head. Cream body, amber nub. Not a diamond chip. */
export function traceTapCanister(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number
): void {
  const bodyW = r * 0.42;
  const bodyTop = y - r * 0.35;
  const bodyBottom = y + r * 0.7;
  const tipY = y - r * 0.78;
  ctx.moveTo(x - bodyW, bodyTop);
  ctx.lineTo(x - bodyW, bodyBottom - bodyW);
  ctx.lineTo(x, bodyBottom);
  ctx.lineTo(x + bodyW, bodyBottom - bodyW);
  ctx.lineTo(x + bodyW, bodyTop);
  ctx.closePath();
  ctx.moveTo(x - bodyW * 0.55, bodyTop);
  ctx.lineTo(x - bodyW * 0.18, tipY);
  ctx.lineTo(x + bodyW * 0.18, tipY);
  ctx.lineTo(x + bodyW * 0.55, bodyTop);
}

function traceTapCanisterTip(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const bodyW = r * 0.42;
  const bodyTop = y - r * 0.35;
  const tipY = y - r * 0.78;
  ctx.moveTo(x - bodyW * 0.55, bodyTop);
  ctx.lineTo(x - bodyW * 0.18, tipY);
  ctx.lineTo(x + bodyW * 0.18, tipY);
  ctx.lineTo(x + bodyW * 0.55, bodyTop);
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

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  for (const drop of loot) {
    const projected = canvasManager.worldToScreen(drop.position, ship.position);
    const screen = { x: projected.x, y: projected.y };
    const equipment = isEquipmentId(drop.kind) ? drop.kind : null;
    const prominent = equipment !== null || drop.kind === 'tap';
    const r = lootScreenRadius(prominent ? Math.max(22, drop.radius) : drop.radius, scale);
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y) || r === null) {
      continue;
    }

    if (prominent && !reducedMotion) {
      screen.y += Math.sin(now / 450 + drop.position.x * 0.01) * 6 * scale;
    }
    const isShard = drop.kind === 'shard';
    const isTap = drop.kind === 'tap';
    const isDenseShard = isShard && Number.isFinite(drop.mass) && drop.mass >= 0.5;
    const color = PALETTE.LOOT;
    const pulse =
      prominent && !reducedMotion
        ? 1 + 0.08 * Math.sin((now / VISUAL.TAP_LOOT_PULSE_MS) * Math.PI * 2)
        : 1;
    const drawR = r * pulse;
    const glow = prominent ? VISUAL.TAP_LOOT_GLOW : VISUAL.LOOT_GLOW;
    const trace = (): void => {
      ctx.beginPath();
      if (equipment) {
        addResourceMapPath(ctx, equipment, screen.x, screen.y, drawR);
        return;
      }
      if (drop.kind === 'silk') {
        addResourceMapPath(ctx, 'silk', screen.x, screen.y, r);
        return;
      }
      if (isTap) {
        traceTapCanister(ctx, screen.x, screen.y, drawR);
        return;
      }
      traceDiamond(ctx, screen.x, screen.y, r);
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
    ctx.shadowBlur = resolveGlow(glow);
    ctx.strokeStyle = hexToRgba(color, 0.55);
    trace();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    trace();
    ctx.stroke();
    if (prominent) {
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.shadowColor = PALETTE.BG;
      ctx.shadowBlur = resolveGlow(4);
      ctx.fillText(
        equipment ? EQUIPMENT[equipment].name.toUpperCase() : 'TAP CANISTER',
        screen.x,
        screen.y + drawR + 7
      );
    }
    if (isTap) {
      ctx.strokeStyle = PALETTE.LASER_LOCAL;
      ctx.shadowColor = PALETTE.LASER_LOCAL;
      ctx.shadowBlur = resolveGlow(VISUAL.LOOT_GLOW);
      ctx.beginPath();
      traceTapCanisterTip(ctx, screen.x, screen.y, drawR);
      ctx.stroke();
    }
    ctx.restore();
  }
}
