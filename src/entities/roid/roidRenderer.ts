import type { AsteroidMaterial } from '../../../shared-types';
import { PALETTE, ROID, VISUAL } from '../../constants';
import type { Ship } from '../../entities/ship/Ship';
import { isAsteroidPending, pendingElapsedMs } from '../../physics/collision/asteroidHitFeel';
import { canvasManager } from '../../rendering/canvas';
import {
  drawingOffsets,
  PLAYFIELD_CLOSE_SCALE,
  type PlayfieldRock,
} from '../../rendering/playfieldCamera';
import {
  driftSegment,
  polygonPoints,
  strokeBurstTicks,
  strokePhosphorPolyline,
  type Vec2,
} from '../../rendering/vectorJuice';
import { drawAsteroidMaterialDetails } from './materialArt';
import type { Roid } from './Roid';

const zoomRockScratch: PlayfieldRock[] = [];
const roidScreen = { x: 0, y: 0 };
const shatterBursts: Array<{ roid: Roid; startedAt: number }> = [];

/** Keep the approved break visible after the authoritative rock is removed. */
export function recordAsteroidShatter(roid: Roid, now = performance.now()): void {
  shatterBursts.push({ roid, startedAt: now });
  if (shatterBursts.length > 48) {
    shatterBursts.shift();
  }
}

export function clearAsteroidShatters(): void {
  shatterBursts.length = 0;
}

/** Zoom from rocks the playfield will actually stroke — not pending or NaN poses. */
export function rocksForPlayfieldZoom(roids: readonly Roid[]): PlayfieldRock[] {
  let count = 0;
  for (const roid of roids) {
    if (isAsteroidPending(roid) || !canDrawAsteroid(roid)) {
      continue;
    }
    zoomRockScratch[count] = roid;
    count += 1;
  }
  zoomRockScratch.length = count;
  return zoomRockScratch;
}

export function getRoidStrokeWidth(radius: number): number {
  if (radius >= ROID.SIZE * 0.8) {
    return VISUAL.ROID_STROKE_LARGE;
  }
  if (radius >= ROID.SIZE * 0.4) {
    return VISUAL.ROID_STROKE_MEDIUM;
  }
  return VISUAL.ROID_STROKE_SMALL;
}

/** Classic Asteroids inner facet on large rocks only — medium/small stay one outline. */
export function shouldDrawRoidInnerFacet(radius: number): boolean {
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
  ctx: CanvasRenderingContext2D,
  points: readonly Vec2[],
  radius: number,
  inner: readonly Vec2[]
): void {
  const width = getRoidStrokeWidth(radius);
  strokePhosphorPolyline(ctx, points, PALETTE.ROID, width, VISUAL.ROID_GLOW, true);
  if (inner.length > 2) {
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

/** Number of reflective facets to show at the current energy level. */
export function reflectiveFacetCueCount(energy: number, maxEnergy: number): number {
  if (!Number.isFinite(energy) || !Number.isFinite(maxEnergy) || maxEnergy <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(3, Math.ceil((Math.max(0, energy) / maxEnergy) * 3)));
}

function drawReflectiveCue(
  ctx: CanvasRenderingContext2D,
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

function drawSpinCue(ctx: CanvasRenderingContext2D, radius: number, charged: boolean): void {
  const ring = radius * 1.18;
  const arc = charged ? Math.PI * 0.68 : Math.PI * 0.42;
  ctx.globalAlpha = charged ? 0.88 : 0.56;
  ctx.strokeStyle = PALETTE.ROID;
  ctx.lineWidth = Math.max(0.7, Math.min(1.05, radius * 0.045));
  ctx.beginPath();
  ctx.arc(0, 0, ring, -Math.PI * 0.95, -Math.PI * 0.95 + arc);
  ctx.stroke();
  if (charged) {
    ctx.beginPath();
    ctx.arc(0, 0, ring, Math.PI * 0.05, Math.PI * 0.05 + arc);
    ctx.stroke();
  }
}

/** Draw only sparse, screen-readable metadata cues; the rock remains an outline. */
export function drawRoidInteractionCues(
  ctx: CanvasRenderingContext2D,
  roid: Pick<Roid, 'phenomenon' | 'spinClass'>,
  radius: number,
  centerX = 0,
  centerY = 0
): void {
  if (!(radius > 0) || !Number.isFinite(radius)) {
    return;
  }
  const phenomenon = roid.phenomenon;
  if (!phenomenon && !roid.spinClass) {
    return;
  }
  ctx.save();
  // Cue geometry is authored around the origin so each marker stays aligned
  // with its rock after the world-to-screen projection.
  ctx.translate(centerX, centerY);
  if (phenomenon?.kind === 'reflective') {
    drawReflectiveCue(ctx, radius, phenomenon.energy, phenomenon.maxEnergy);
  }
  if (roid.spinClass) {
    drawSpinCue(ctx, radius, roid.spinClass === 'charged');
  }
  ctx.restore();
}

function drawRoidShatter(
  ctx: CanvasRenderingContext2D,
  origin: Vec2,
  points: readonly Vec2[],
  radius: number,
  t: number,
  material?: AsteroidMaterial
): void {
  const alpha = 1 - t * 0.85;
  const spread =
    radius *
    VISUAL.ROID_SHATTER_SPREAD *
    (material === 'ice' ? 1.2 : material === 'metal' ? 0.55 : 1);
  ctx.save();
  ctx.strokeStyle = PALETTE.ROID;
  ctx.shadowColor = PALETTE.ROID;
  ctx.shadowBlur = VISUAL.ROID_GLOW;
  ctx.lineWidth = VISUAL.ROID_STROKE_SMALL;
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) {
      continue;
    }
    const edge = driftSegment(a, b, origin, t, spread);
    const wobble = material === 'rubble' ? Math.sin(i * 2.4 + t * 8) * radius * t * 0.3 : 0;
    ctx.beginPath();
    ctx.moveTo(edge.a.x + wobble, edge.a.y - wobble);
    ctx.lineTo(edge.b.x - wobble, edge.b.y + wobble);
    ctx.stroke();
  }
  ctx.restore();

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

  const scale = PLAYFIELD_CLOSE_SCALE;
  const viewport = cvs ? canvasManager.getViewportSize() : undefined;
  const viewW = viewport?.width ?? Number.POSITIVE_INFINITY;
  const viewH = viewport?.height ?? Number.POSITIVE_INFINITY;

  for (const roid of roids) {
    if (!canDrawAsteroid(roid)) {
      continue;
    }

    const screenPos = canvasManager.worldToScreenInto(roidScreen, roid.position, ship.position);
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
    const outline = roidOutline(screenPos, r, roid.angle, vertices, offsets);

    if (isAsteroidPending(roid)) {
      const elapsed = pendingElapsedMs(roid);
      if (elapsed !== null && elapsed < VISUAL.ROID_SHATTER_MS) {
        drawRoidShatter(
          ctx,
          screenPos,
          outline,
          r,
          elapsed / VISUAL.ROID_SHATTER_MS,
          roid.material
        );
      }
      continue;
    }

    const inner =
      !roid.material && shouldDrawRoidInnerFacet(roid.r)
        ? roidOutline(screenPos, r, roid.angle, vertices, offsets, VISUAL.ROID_INNER_SCALE)
        : [];
    drawRoidSilhouette(ctx, outline, roid.r, inner);
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
    drawRoidInteractionCues(ctx, roid, r, screenPos.x, screenPos.y);
  }

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
    drawRoidShatter(ctx, screen, outline, radius, elapsed / VISUAL.ROID_SHATTER_MS, rock.material);
  }
  ctx.shadowBlur = 0;
}
