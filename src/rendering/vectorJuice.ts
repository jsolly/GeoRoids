import { hexToRgba } from '../utils/colorUtils';
import type { DrawingContext } from './drawingContext';

export type Vec2 = { x: number; y: number };

export function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

/** Fast pop, then a soft coast — Geometry Wars juice without a fireball. */
export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

export function burstTick(
  x: number,
  y: number,
  angle: number,
  inner: number,
  outer: number
): { x1: number; y1: number; x2: number; y2: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x1: x + c * inner,
    y1: y - s * inner,
    x2: x + c * outer,
    y2: y - s * outer,
  };
}

export function driftSegment(
  a: Vec2,
  b: Vec2,
  origin: Vec2,
  t: number,
  spread: number,
  spin = 0.55
): { a: Vec2; b: Vec2 } {
  const pop = easeOutCubic(t);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const len = Math.hypot(midX - origin.x, midY - origin.y) || 1;
  const dx = ((midX - origin.x) / len) * spread * pop;
  const dy = ((midY - origin.y) / len) * spread * pop;
  const angle = pop * spin;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rot = (p: Vec2): Vec2 => ({
    x: midX + dx + (p.x - midX) * cos - (p.y - midY) * sin,
    y: midY + dy + (p.x - midX) * sin + (p.y - midY) * cos,
  });
  return { a: rot(a), b: rot(b) };
}

export function polygonPoints(
  cx: number,
  cy: number,
  r: number,
  angle: number,
  vertices: number,
  offsets: readonly number[],
  scale = 1
): Vec2[] {
  const n = Math.max(vertices, 1);
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const offset = offsets[i] ?? 1;
    const a = angle + (i * Math.PI * 2) / n;
    pts.push({
      x: cx + r * scale * offset * Math.cos(a),
      y: cy + r * scale * offset * Math.sin(a),
    });
  }
  return pts;
}

export function thrusterFlameGeometry(
  x: number,
  y: number,
  angle: number,
  radius: number,
  lengthRatio: number,
  coreRatio: number,
  rearOverride?: Vec2
): {
  rear: Vec2;
  left: Vec2;
  right: Vec2;
  tip: Vec2;
  coreLeft: Vec2;
  coreRight: Vec2;
  coreTip: Vec2;
} {
  const rear = rearOverride ?? {
    x: x - radius * 0.8 * Math.cos(angle),
    y: y + radius * 0.8 * Math.sin(angle),
  };
  const flameLength = radius * lengthRatio;
  const coreLength = flameLength * coreRatio;
  const halfWidth = radius * 0.2;
  const coreHalf = halfWidth * 0.55;
  return {
    rear,
    left: {
      x: rear.x + Math.sin(angle) * halfWidth,
      y: rear.y + Math.cos(angle) * halfWidth,
    },
    right: {
      x: rear.x - Math.sin(angle) * halfWidth,
      y: rear.y - Math.cos(angle) * halfWidth,
    },
    tip: {
      x: rear.x - Math.cos(angle) * flameLength,
      y: rear.y + Math.sin(angle) * flameLength,
    },
    coreLeft: {
      x: rear.x + Math.sin(angle) * coreHalf,
      y: rear.y + Math.cos(angle) * coreHalf,
    },
    coreRight: {
      x: rear.x - Math.sin(angle) * coreHalf,
      y: rear.y - Math.cos(angle) * coreHalf,
    },
    coreTip: {
      x: rear.x - Math.cos(angle) * coreLength,
      y: rear.y + Math.sin(angle) * coreLength,
    },
  };
}

export function laserBoltOffsets(
  vx: number,
  vy: number,
  halfLength: number,
  trailLength: number
): { halfX: number; halfY: number; trailX: number; trailY: number } {
  const speed = Math.hypot(vx, vy);
  const dx = speed > 0 ? vx / speed : 1;
  const dy = speed > 0 ? vy / speed : 0;
  return {
    halfX: dx * halfLength,
    halfY: dy * halfLength,
    trailX: dx * trailLength,
    trailY: dy * trailLength,
  };
}

export function strokePhosphorPolyline(
  ctx: DrawingContext,
  points: readonly Vec2[],
  color: string,
  width: number,
  glow: number,
  closed: boolean,
  alpha = 1
): void {
  const first = points[0];
  if (first === undefined) {
    return;
  }

  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      if (point !== undefined) {
        ctx.lineTo(point.x, point.y);
      }
    }
    if (closed) {
      ctx.closePath();
    }
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.strokeStyle = hexToRgba(color, 0.4 * alpha);
  trace();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexToRgba(color, alpha);
  trace();
  ctx.stroke();
  ctx.restore();
}

export function strokeBurstTicks(
  ctx: DrawingContext,
  x: number,
  y: number,
  count: number,
  phase: number,
  inner: number,
  outer: number,
  color: string,
  alpha: number,
  width: number,
  glow: number
): void {
  ctx.save();
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const tick = burstTick(x, y, phase + (i * Math.PI * 2) / count, inner, outer);
    ctx.beginPath();
    ctx.moveTo(tick.x1, tick.y1);
    ctx.lineTo(tick.x2, tick.y2);
    ctx.stroke();
  }
  ctx.restore();
}
