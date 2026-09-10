import type { SoftFactionId } from './softFactions';

/** Game Director art call. Tiny marks only — never hull paint. */
export const FACTION_MARK_COLORS = {
  ion: '#A8A0C8',
  ember: '#D4B896',
} as const;

/** Ownership hull strokes. Soft factions must not reuse these as hull fill/stroke. */
export const OWNERSHIP_HULL_COLORS = {
  local: '#5EEAD4',
  bot: '#FB923C',
} as const;

export const FACTION_MARK_RADIUS_RATIO = 0.26;

type FactionMarkContext = 'hull' | 'label' | 'hud' | 'minimap';

const FACTION_MARK_SIZE_LIMITS: Record<FactionMarkContext, { min: number; max: number }> = {
  hull: { min: 2.4, max: 4.5 },
  label: { min: 2.2, max: 3.8 },
  hud: { min: 2.2, max: 3.8 },
  minimap: { min: 1.4, max: 2.6 },
};

interface FactionMarkTarget {
  x: number;
  y: number;
  radius: number;
  angle: number;
  /** Render context keeps a hull chip subordinate while HUD marks stay legible. */
  context?: FactionMarkContext;
}

type FactionMarkPainter = (ctx: CanvasRenderingContext2D, mark: FactionMarkTarget) => void;

function heading(angle: number): { x: number; y: number } {
  const safeAngle = Number.isFinite(angle) ? angle : 0;
  return { x: Math.cos(safeAngle), y: -Math.sin(safeAngle) };
}

/** Screen-space size per render context; this is a half-extent, not a diameter. */
export function factionMarkScreenSize(
  radius: number,
  context: FactionMarkContext = 'hull'
): number {
  const limits = FACTION_MARK_SIZE_LIMITS[context];
  const raw = Number.isFinite(radius) && radius > 0 ? radius * FACTION_MARK_RADIUS_RATIO : 0;
  return Math.min(limits.max, Math.max(limits.min, raw));
}

function validTarget(mark: FactionMarkTarget): boolean {
  return (
    Number.isFinite(mark.x) &&
    Number.isFinite(mark.y) &&
    Number.isFinite(mark.radius) &&
    mark.radius > 0
  );
}

function paintIonChevron(ctx: CanvasRenderingContext2D, mark: FactionMarkTarget): void {
  const size = factionMarkScreenSize(mark.radius, mark.context);
  const fwd = heading(mark.angle);
  const leftX = -fwd.y;
  const leftY = fwd.x;
  const tipX = mark.x + fwd.x * size;
  const tipY = mark.y + fwd.y * size;
  const aft = size * 0.85;
  const spread = size * 0.7;

  ctx.save();
  ctx.strokeStyle = FACTION_MARK_COLORS.ion;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(tipX - fwd.x * aft + leftX * spread, tipY - fwd.y * aft + leftY * spread);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tipX - fwd.x * aft - leftX * spread, tipY - fwd.y * aft - leftY * spread);
  ctx.stroke();
  ctx.restore();
}

function paintEmberDiamond(ctx: CanvasRenderingContext2D, mark: FactionMarkTarget): void {
  const size = factionMarkScreenSize(mark.radius, mark.context);
  const fwd = heading(mark.angle);
  const leftX = -fwd.y;
  const leftY = fwd.x;

  ctx.save();
  ctx.strokeStyle = FACTION_MARK_COLORS.ember;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(mark.x + fwd.x * size, mark.y + fwd.y * size);
  ctx.lineTo(mark.x + leftX * size * 0.65, mark.y + leftY * size * 0.65);
  ctx.lineTo(mark.x - fwd.x * size, mark.y - fwd.y * size);
  ctx.lineTo(mark.x - leftX * size * 0.65, mark.y - leftY * size * 0.65);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * Soft-faction art hook. Swap a painter without recoloring hulls.
 * ION = chevron, EMBER = diamond.
 */
export const FACTION_MARK_PAINTERS: Record<SoftFactionId, FactionMarkPainter> = {
  ion: paintIonChevron,
  ember: paintEmberDiamond,
};

export function registerFactionMarkPainter(id: SoftFactionId, painter: FactionMarkPainter): void {
  FACTION_MARK_PAINTERS[id] = painter;
}

export function getFactionMarkColor(id: SoftFactionId): string {
  return FACTION_MARK_COLORS[id];
}

/** Tiny mark only. No-op when the factions stream has not assigned a side. */
export function drawSoftFactionMark(
  ctx: CanvasRenderingContext2D,
  factionId: SoftFactionId | undefined,
  mark: FactionMarkTarget
): void {
  if (!factionId || !validTarget(mark)) {
    return;
  }
  FACTION_MARK_PAINTERS[factionId]?.(ctx, mark);
}
