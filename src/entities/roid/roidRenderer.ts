import { isColossalAsteroid } from '../../../shared/asteroidScale';
import { oreResource, oreYield } from '../../../shared/economy';
import type { AsteroidMaterial } from '../../../shared-types';
import { PALETTE, ROID, VISUAL } from '../../constants';
import type { Ship } from '../../entities/ship/Ship';
import { canvasManager } from '../../rendering/canvasSurface';
import type { DrawingContext } from '../../rendering/drawingContext';
import { drawingOffsets } from '../../rendering/playfieldCamera';
import { resolveGlow } from '../../rendering/renderQuality';
import {
  driftSegment,
  easeOutCubic,
  polygonPoints,
  strokeBurstTicks,
  strokePhosphorPolyline,
  type Vec2,
} from '../../rendering/vectorJuice';
import { latchShudderOffset } from './latchShudder';
import { drawAsteroidMaterialDetails } from './materialArt';
import type { Roid } from './Roid';

const roidScreen = { x: 0, y: 0 };
const latchShudders = new Map<string, number>();

interface RoidSilhouetteSprite {
  radius: number;
  vertices: number;
  offsets: readonly number[];
  inner: boolean;
  canvas: HTMLCanvasElement;
  origin: number;
  lastUsedFrame: number;
}

interface RoidSilhouetteSprites {
  dpr: number;
  scale: number;
  glow: number;
  entries: Map<string, RoidSilhouetteSprite>;
  pixels: number;
  frame: number;
}

const MAX_ROID_SILHOUETTE_SPRITES = 128;
const MAX_ROID_SILHOUETTE_PIXELS = 8_000_000;
let roidSilhouetteSprites: RoidSilhouetteSprites | null = null;

export function recordAsteroidLatch(id: string, now = performance.now()): void {
  latchShudders.set(id, now);
}

type AsteroidShatterKind = 'break' | 'furnace';

const shatterBursts: Array<{ roid: Roid; startedAt: number; kind: AsteroidShatterKind }> = [];

/** Keep the approved break visible after the authoritative rock is removed. */
export function recordAsteroidShatter(
  roid: Roid,
  now = performance.now(),
  kind: AsteroidShatterKind = 'break'
): void {
  shatterBursts.push({ roid, startedAt: now, kind });
  if (shatterBursts.length > 48) {
    shatterBursts.shift();
  }
}

/** Furnace delivery retags an in-flight shatter so intake reads as fire, not a laser break. */
export function markFurnaceAsteroidShatter(asteroidId: string): void {
  for (let i = shatterBursts.length - 1; i >= 0; i--) {
    const burst = shatterBursts[i];
    if (burst?.roid.id === asteroidId) {
      burst.kind = 'furnace';
      return;
    }
  }
}

export function clearAsteroidShatters(): void {
  shatterBursts.length = 0;
  latchShudders.clear();
  roidSilhouetteSprites = null;
}

export function getRoidStrokeWidth(
  radius: number
):
  | typeof VISUAL.ROID_STROKE_COLOSSAL
  | typeof VISUAL.ROID_STROKE_LARGE
  | typeof VISUAL.ROID_STROKE_MEDIUM
  | typeof VISUAL.ROID_STROKE_SMALL {
  if (isColossalAsteroid(radius)) {
    return VISUAL.ROID_STROKE_COLOSSAL;
  }
  if (radius >= ROID.SIZE * 0.8) {
    return VISUAL.ROID_STROKE_LARGE;
  }
  if (radius >= ROID.SIZE * 0.4) {
    return VISUAL.ROID_STROKE_MEDIUM;
  }
  return VISUAL.ROID_STROKE_SMALL;
}

/** Classic Asteroids inner facet on large rocks only — medium/small stay one outline. */
function shouldDrawRoidInnerFacet(radius: number): boolean {
  return radius >= ROID.SIZE * 0.8;
}

/** Skip a pose that would throw during path construction and crash the frame. */
export function canDrawAsteroid(roid: {
  position: { x: number; y: number };
  r: number;
  angle: number;
  offsets: number[];
}): boolean {
  const offsets = drawingOffsets(roid.offsets);
  return (
    Number.isFinite(roid.position.x) &&
    Number.isFinite(roid.position.y) &&
    Number.isFinite(roid.r) &&
    Number.isFinite(roid.angle) &&
    Number.isFinite(offsets[0])
  );
}

function roidOutline(
  screen: Vec2,
  radius: number,
  angle: number,
  vertices: number,
  offsets: readonly number[],
  scale = 1
): Vec2[] {
  return polygonPoints(screen.x, screen.y, radius, angle, vertices, offsets, scale);
}

function drawRoidSilhouette(
  ctx: DrawingContext,
  points: readonly Vec2[],
  radius: number,
  inner: readonly Vec2[] | null
): void {
  const width = getRoidStrokeWidth(radius);
  strokePhosphorPolyline(ctx, points, PALETTE.ROID, width, VISUAL.ROID_GLOW, true);
  if (inner && inner.length > 2) {
    strokePhosphorPolyline(
      ctx,
      inner,
      PALETTE.ROID,
      VISUAL.ROID_STROKE_SMALL,
      VISUAL.ROID_GLOW * 0.45,
      true,
      0.62
    );
  }
}

/** Share backing resolution and glow state across this frame's asteroid sprites. */
function prepareRoidSilhouetteSprites(
  ctx: CanvasRenderingContext2D,
  scale: number
): RoidSilhouetteSprites {
  const transform = ctx.getTransform();
  const dpr = Math.hypot(transform.a, transform.b);
  const glow = resolveGlow(VISUAL.ROID_GLOW);
  if (
    !roidSilhouetteSprites ||
    roidSilhouetteSprites.dpr !== dpr ||
    roidSilhouetteSprites.scale !== scale ||
    roidSilhouetteSprites.glow !== glow
  ) {
    roidSilhouetteSprites = { dpr, scale, glow, entries: new Map(), pixels: 0, frame: 0 };
  }
  roidSilhouetteSprites.frame += 1;
  return roidSilhouetteSprites;
}

/** Cache only the unchanging outline; health and interaction overlays stay live. */
function drawCachedRoidSilhouette(
  ctx: CanvasRenderingContext2D,
  cache: RoidSilhouetteSprites,
  roid: Roid,
  screen: Vec2,
  offsets: readonly number[],
  vertices: number
): void {
  const inner = !roid.material && shouldDrawRoidInnerFacet(roid.r);
  let sprite = cache.entries.get(roid.id);
  if (
    !sprite ||
    sprite.radius !== roid.r ||
    sprite.vertices !== vertices ||
    sprite.inner !== inner ||
    sprite.offsets.length !== offsets.length ||
    !offsets.every((offset, index) => offset === sprite?.offsets[index])
  ) {
    const radius = roid.r * cache.scale;
    const extent = Math.abs(radius) * Math.max(1, ...offsets.map(Math.abs));
    // Shadow blur is measured in backing pixels, independently of the DPR transform.
    const padding = getRoidStrokeWidth(roid.r) / 2 + (3 * cache.glow + 2) / cache.dpr;
    const side = Math.ceil((extent + padding) * 2 * cache.dpr);
    if (sprite) {
      cache.pixels -= sprite.canvas.width * sprite.canvas.height;
      cache.entries.delete(roid.id);
    }
    if (side * side <= MAX_ROID_SILHOUETTE_PIXELS) {
      while (
        cache.entries.size >= MAX_ROID_SILHOUETTE_SPRITES ||
        cache.pixels + side * side > MAX_ROID_SILHOUETTE_PIXELS
      ) {
        let evicted = false;
        for (const [id, candidate] of cache.entries) {
          if (candidate.lastUsedFrame === cache.frame) {
            continue;
          }
          cache.pixels -= candidate.canvas.width * candidate.canvas.height;
          cache.entries.delete(id);
          evicted = true;
          break;
        }
        if (!evicted) {
          break;
        }
      }
    }
    if (
      cache.entries.size >= MAX_ROID_SILHOUETTE_SPRITES ||
      cache.pixels + side * side > MAX_ROID_SILHOUETTE_PIXELS
    ) {
      // Keep full-size artwork when the bitmap is too large or all retained art
      // is already in use this frame. Crowded scenes must not repaint the cache.
      drawRoidSilhouette(
        ctx,
        roidOutline(screen, radius, roid.angle, vertices, offsets),
        roid.r,
        inner
          ? roidOutline(screen, radius, roid.angle, vertices, offsets, VISUAL.ROID_INNER_SCALE)
          : null
      );
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const paint = canvas.getContext('2d');
    if (!paint) {
      throw new Error('Asteroid silhouette canvas context unavailable');
    }
    const origin = canvas.width / (2 * cache.dpr);
    paint.setTransform(cache.dpr, 0, 0, cache.dpr, 0, 0);
    const center = { x: origin, y: origin };
    drawRoidSilhouette(
      paint,
      roidOutline(center, radius, 0, vertices, offsets),
      roid.r,
      inner ? roidOutline(center, radius, 0, vertices, offsets, VISUAL.ROID_INNER_SCALE) : null
    );
    sprite = {
      radius: roid.r,
      vertices,
      offsets: [...offsets],
      inner,
      canvas,
      origin,
      lastUsedFrame: cache.frame,
    };
    // Numeric comparison survives snapshot array replacement. Retained canvases
    // use at most 8 million backing pixels (~32 MiB RGBA) across 128 IDs.
    cache.entries.set(roid.id, sprite);
    cache.pixels += side * side;
  }
  sprite.lastUsedFrame = cache.frame;
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(roid.angle);
  ctx.shadowBlur = 0;
  ctx.drawImage(
    sprite.canvas,
    -sprite.origin,
    -sprite.origin,
    sprite.canvas.width / cache.dpr,
    sprite.canvas.height / cache.dpr
  );
  ctx.restore();
}

/** Number of reflective facets to show at the current energy level. */
export function reflectiveFacetCueCount(energy: number, maxEnergy: number): number {
  if (!Number.isFinite(energy) || !Number.isFinite(maxEnergy) || maxEnergy <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(3, Math.ceil((Math.max(0, energy) / maxEnergy) * 3)));
}

function drawReflectiveCue(
  ctx: DrawingContext,
  radius: number,
  energy: number,
  maxEnergy: number
): void {
  const count = reflectiveFacetCueCount(energy, maxEnergy);
  ctx.globalAlpha = 0.72;
  ctx.strokeStyle = PALETTE.ROID;
  ctx.lineWidth = Math.max(0.7, Math.min(1.1, radius * 0.055));
  ctx.lineCap = 'round';
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI * 0.72 + index * Math.PI * 0.72;
    const inner = radius * 0.22;
    const outer = radius * (0.5 + index * 0.06);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.stroke();
  }
}

/** Draw only sparse, screen-readable metadata cues; the rock remains an outline. */
export function drawRoidInteractionCues(
  ctx: DrawingContext,
  roid: Pick<Roid, 'phenomenon'>,
  radius: number,
  centerX = 0,
  centerY = 0
): void {
  if (!(radius > 0) || !Number.isFinite(radius)) {
    return;
  }
  const phenomenon = roid.phenomenon;
  if (!phenomenon) {
    return;
  }
  ctx.save();
  // Cue geometry is authored around the origin so each marker stays aligned
  // with its rock after the world-to-screen projection.
  ctx.translate(centerX, centerY);
  if (phenomenon?.kind === 'reflective') {
    drawReflectiveCue(ctx, radius, phenomenon.energy, phenomenon.maxEnergy);
  }
  ctx.restore();
}

/** Guidance heading is independent of the asteroid silhouette's spin. */
function drawAsteroidBoost(
  ctx: DrawingContext,
  roid: Roid,
  x: number,
  y: number,
  radius: number
): void {
  const boost = roid.boost;
  if (!boost) {
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-boost.angle);
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = resolveGlow(VISUAL.ROID_GLOW);
  ctx.beginPath();
  ctx.moveTo(-radius - 5, -4);
  ctx.lineTo(-radius + 2, -4);
  ctx.lineTo(-radius + 2, 4);
  ctx.lineTo(-radius - 5, 4);
  ctx.stroke();
  if (boost.phase === 'armed') {
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(radius + 5, 0);
    ctx.lineTo(radius + 38, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(radius + 31, -5);
    ctx.lineTo(radius + 38, 0);
    ctx.lineTo(radius + 31, 5);
    ctx.stroke();
  } else {
    const length = 24 + Math.sin(performance.now() / 65) * 5;
    ctx.beginPath();
    ctx.moveTo(-radius - 5, -4);
    ctx.lineTo(-radius - length, 0);
    ctx.lineTo(-radius - 5, 4);
    ctx.stroke();
    ctx.strokeStyle = PALETTE.LASER_LOCAL;
    ctx.beginPath();
    ctx.moveTo(-radius - 5, 0);
    ctx.lineTo(-radius - length * 0.6, 0);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFurnaceSmokePoof(ctx: DrawingContext, origin: Vec2, radius: number, t: number): void {
  const pop = easeOutCubic(t);
  const alpha = Math.max(0, 1 - t) * 0.62;
  ctx.save();
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.shadowColor = PALETTE.HUD_MUTED;
  ctx.shadowBlur = resolveGlow(VISUAL.ROID_GLOW * 0.55);
  ctx.lineWidth = VISUAL.ROID_STROKE_SMALL;
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  const wisps = VISUAL.ROID_FURNACE_SMOKE_WISPS;
  for (let i = 0; i < wisps; i++) {
    const spread = (i - (wisps - 1) / 2) * 0.38;
    const heading = -Math.PI / 2 + spread;
    const lift = radius * (0.2 + pop * 1.15);
    const x = origin.x + Math.cos(heading) * lift * 0.72;
    const y = origin.y + Math.sin(heading) * lift;
    const size = radius * (0.14 + pop * 0.22 + Math.abs(spread) * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, size, heading - 0.85, heading + 2.05);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRoidShatter(
  ctx: DrawingContext,
  origin: Vec2,
  points: readonly Vec2[],
  radius: number,
  t: number,
  material: AsteroidMaterial | undefined,
  kind: AsteroidShatterKind
): void {
  const furnace = kind === 'furnace';
  const ink = furnace ? PALETTE.DANGER : PALETTE.ROID;
  const alpha = 1 - t * 0.85;
  const spread =
    radius *
    VISUAL.ROID_SHATTER_SPREAD *
    (material === 'ice' ? 1.2 : material === 'metal' ? 0.55 : 1);
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.shadowColor = ink;
  ctx.shadowBlur = resolveGlow(VISUAL.ROID_GLOW);
  ctx.lineWidth = VISUAL.ROID_STROKE_SMALL;
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';

  // Open edges share one halo; overlapping endpoints composite once per burst.
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) {
      continue;
    }
    const edge = driftSegment(a, b, origin, t, spread);
    const wobble = material === 'rubble' ? Math.sin(i * 2.4 + t * 8) * radius * t * 0.3 : 0;
    ctx.moveTo(edge.a.x + wobble, edge.a.y - wobble);
    ctx.lineTo(edge.b.x - wobble, edge.b.y + wobble);
  }
  ctx.stroke();
  ctx.restore();

  if (furnace) {
    drawFurnaceSmokePoof(ctx, origin, radius, t);
    return;
  }

  strokeBurstTicks(
    ctx,
    origin.x,
    origin.y,
    VISUAL.LASER_HIT_TICKS,
    t * 0.4,
    radius * (0.25 + t * 0.35),
    radius * (0.55 + t * 0.85),
    PALETTE.ROID,
    alpha,
    1,
    VISUAL.ROID_GLOW
  );
}

export function drawRoidsRelative(ship: Ship, roids: Roid[]): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx) {
    return;
  }

  const scale = canvasManager.getPlayfieldScale();
  const silhouettes = prepareRoidSilhouetteSprites(ctx, scale);
  const viewport = cvs ? canvasManager.getViewportSize() : undefined;
  const viewW = viewport?.width ?? Number.POSITIVE_INFINITY;
  const viewH = viewport?.height ?? Number.POSITIVE_INFINITY;

  const now = performance.now();
  for (const [id, startedAt] of latchShudders) {
    if (now - startedAt >= 240) {
      latchShudders.delete(id);
    }
  }
  for (const roid of roids) {
    if (!canDrawAsteroid(roid)) {
      continue;
    }

    const screenPos = canvasManager.worldToScreenInto(roidScreen, roid.position, ship.position);
    const latchStart = latchShudders.get(roid.id);
    if (latchStart !== undefined) {
      const kick = latchShudderOffset(now - latchStart);
      screenPos.x += kick;
      screenPos.y += kick * 0.35;
    }
    const r = roid.r * scale;
    if (
      screenPos.x < -r ||
      screenPos.y < -r ||
      screenPos.x > viewW + r ||
      screenPos.y > viewH + r
    ) {
      continue;
    }
    const offsets = drawingOffsets(roid.offsets);
    const vertices = Math.max(roid.vertices, 1);
    drawCachedRoidSilhouette(ctx, silhouettes, roid, screenPos, offsets, vertices);
    if (roid.material) {
      drawAsteroidMaterialDetails(
        ctx,
        roid.material,
        screenPos.x,
        screenPos.y,
        r,
        roid.angle,
        roid.health / roid.maxHealth
      );
    }
    if (roid.surveyedBy?.length) {
      const resource = oreResource(roid);
      ctx.save();
      ctx.font = '11px Arial';
      ctx.textAlign = 'center';
      ctx.fillStyle = resource ? '#B7EFDD' : '#94A3B8';
      ctx.fillText(
        resource ? `${resource.toUpperCase()} · ${oreYield({ size: roid.r })} ore` : 'BARREN',
        screenPos.x,
        screenPos.y + r + 16
      );
      ctx.restore();
    }
    drawRoidInteractionCues(ctx, roid, r, screenPos.x, screenPos.y);
    drawAsteroidBoost(ctx, roid, screenPos.x, screenPos.y, r);
  }
  ctx.shadowBlur = 0;
}

/** Paint in-flight breaks after hearths so a last-rock furnace poof stays readable. */
export function drawAsteroidShatterBursts(ship: Ship): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx) {
    return;
  }

  const scale = canvasManager.getPlayfieldScale();
  const viewport = cvs ? canvasManager.getViewportSize() : undefined;
  const viewW = viewport?.width ?? Number.POSITIVE_INFINITY;
  const viewH = viewport?.height ?? Number.POSITIVE_INFINITY;
  const now = performance.now();

  for (let i = shatterBursts.length - 1; i >= 0; i--) {
    const burst = shatterBursts[i];
    if (!burst) {
      continue;
    }
    const elapsed = now - burst.startedAt;
    if (elapsed >= VISUAL.ROID_SHATTER_MS) {
      shatterBursts.splice(i, 1);
      continue;
    }
    const rock = burst.roid;
    if (!canDrawAsteroid(rock)) {
      continue;
    }
    const screen = canvasManager.worldToScreenInto(roidScreen, rock.position, ship.position);
    const radius = rock.r * scale;
    if (
      screen.x < -radius * 3 ||
      screen.y < -radius * 3 ||
      screen.x > viewW + radius * 3 ||
      screen.y > viewH + radius * 3
    ) {
      continue;
    }
    const outline = roidOutline(
      screen,
      radius,
      rock.angle,
      rock.vertices,
      drawingOffsets(rock.offsets)
    );
    drawRoidShatter(
      ctx,
      screen,
      outline,
      radius,
      elapsed / VISUAL.ROID_SHATTER_MS,
      rock.material,
      burst.kind
    );
  }
  ctx.shadowBlur = 0;
}
