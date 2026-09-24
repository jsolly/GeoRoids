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

type OrdinaryLootKind = Extract<LootData['kind'], 'wreckage' | 'points' | 'shard' | 'silk'>;

interface OrdinaryLootSprite {
  canvas: HTMLCanvasElement;
  origin: number;
}

interface OrdinaryLootSprites {
  dpr: number;
  glow: number;
  styles: Map<string, OrdinaryLootSprite>;
}

let ordinaryLootSprites: OrdinaryLootSprites | null = null;

function isOrdinaryLootKind(kind: LootData['kind']): kind is OrdinaryLootKind {
  return kind === 'wreckage' || kind === 'points' || kind === 'shard' || kind === 'silk';
}

function prepareOrdinaryLootSprites(ctx: CanvasRenderingContext2D): OrdinaryLootSprites {
  const transform = ctx.getTransform();
  const dpr = Math.hypot(transform.a, transform.b);
  const glow = resolveGlow(VISUAL.LOOT_GLOW);
  if (
    !ordinaryLootSprites ||
    ordinaryLootSprites.dpr !== dpr ||
    ordinaryLootSprites.glow !== glow
  ) {
    ordinaryLootSprites = { dpr, glow, styles: new Map() };
  }
  return ordinaryLootSprites;
}

/** Shared original painter for static sprites and uncached prominent loot. */
function strokeLootShape(ctx: CanvasRenderingContext2D, trace: () => void, glow: number): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowBlur = 0;
  ctx.lineWidth = VISUAL.LOOT_UNDERSTROKE;
  ctx.strokeStyle = PALETTE.BG;
  trace();
  ctx.stroke();
  ctx.lineWidth = VISUAL.LOOT_STROKE_WIDTH;
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = resolveGlow(glow);
  ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 0.55);
  trace();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = PALETTE.LOOT;
  trace();
  ctx.stroke();
}

function ordinaryLootHalfPixels(
  kind: OrdinaryLootKind,
  radius: number,
  cache: OrdinaryLootSprites
): number {
  // Silk's control points reach 1.2 radii; contain the complete curves and caps.
  const extent = kind === 'silk' ? radius * 1.2 : radius;
  return Math.ceil((extent + VISUAL.LOOT_UNDERSTROKE / 2) * cache.dpr + 3 * cache.glow + 2);
}

function ordinaryLootSprite(
  kind: OrdinaryLootKind,
  radius: number,
  denseShard: boolean,
  halfPixels: number,
  cache: OrdinaryLootSprites
): OrdinaryLootSprite {
  const canvas = document.createElement('canvas');
  canvas.width = halfPixels * 2;
  canvas.height = halfPixels * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Loot artwork canvas context unavailable');
  }
  const origin = halfPixels / cache.dpr;
  ctx.setTransform(cache.dpr, 0, 0, cache.dpr, 0, 0);
  const trace = (): void => {
    ctx.beginPath();
    if (kind === 'silk') {
      addResourceMapPath(ctx, 'silk', origin, origin, radius);
      return;
    }
    traceDiamond(ctx, origin, origin, radius);
    if (kind === 'shard') {
      traceDiamond(ctx, origin, origin, radius * VISUAL.LOOT_SHARD_INNER);
      if (denseShard) {
        traceDiamond(ctx, origin, origin, radius * VISUAL.LOOT_SHARD_DENSE_INNER);
      }
    }
  };
  strokeLootShape(ctx, trace, VISUAL.LOOT_GLOW);
  return { canvas, origin };
}

function drawOrdinaryLoot(
  ctx: CanvasRenderingContext2D,
  cache: OrdinaryLootSprites,
  usedStyles: Map<string, OrdinaryLootSprite>,
  kind: OrdinaryLootKind,
  radius: number,
  denseShard: boolean,
  x: number,
  y: number,
  viewWidth: number,
  viewHeight: number
): void {
  const halfPixels = ordinaryLootHalfPixels(kind, radius, cache);
  const reach = halfPixels / cache.dpr;
  if (x + reach < 0 || y + reach < 0 || x - reach > viewWidth || y - reach > viewHeight) {
    return;
  }
  const key = `${kind}:${radius}:${denseShard ? 1 : 0}`;
  const sprite =
    usedStyles.get(key) ??
    cache.styles.get(key) ??
    ordinaryLootSprite(kind, radius, denseShard, halfPixels, cache);
  usedStyles.set(key, sprite);
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.drawImage(
    sprite.canvas,
    x - sprite.origin,
    y - sprite.origin,
    sprite.canvas.width / cache.dpr,
    sprite.canvas.height / cache.dpr
  );
  ctx.restore();
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
    ordinaryLootSprites = null;
    return;
  }

  const sprites = prepareOrdinaryLootSprites(ctx);
  const usedStyles = new Map<string, OrdinaryLootSprite>();
  const viewport = canvasManager.getViewportSize();

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

    if (isOrdinaryLootKind(drop.kind)) {
      drawOrdinaryLoot(
        ctx,
        sprites,
        usedStyles,
        drop.kind,
        r,
        drop.kind === 'shard' && Number.isFinite(drop.mass) && drop.mass >= 0.5,
        screen.x,
        screen.y,
        viewport.width,
        viewport.height
      );
      continue;
    }

    if (!reducedMotion) {
      screen.y += Math.sin(now / 450 + drop.position.x * 0.01) * 6 * scale;
    }
    const isTap = drop.kind === 'tap';
    const color = PALETTE.LOOT;
    const pulse = !reducedMotion
      ? 1 + 0.08 * Math.sin((now / VISUAL.TAP_LOOT_PULSE_MS) * Math.PI * 2)
      : 1;
    const drawR = r * pulse;
    const trace = (): void => {
      ctx.beginPath();
      if (equipment) {
        addResourceMapPath(ctx, equipment, screen.x, screen.y, drawR);
      } else {
        traceTapCanister(ctx, screen.x, screen.y, drawR);
      }
    };

    ctx.save();
    strokeLootShape(ctx, trace, VISUAL.TAP_LOOT_GLOW);
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
  sprites.styles = usedStyles;
}
