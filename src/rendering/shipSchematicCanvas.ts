import type { HaulerUtilityId, ScoutUtilityId, ShipKitId } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { traceTapCanister } from '../entities/loot/lootRenderer';
import { latchShudderOffset } from '../entities/roid/latchShudder';
import { HAULER_UTILITY_IDS } from '../entities/ship/haulerUtility';
import {
  getHaulerEquipment,
  getKitHullOutline,
  projectHullPoint,
  projectHullPolyline,
} from '../entities/ship/hullOutlines';
import { SHIP_ABILITY } from '../entities/ship/shipKits';
import { strokeKitHullOutline } from '../entities/ship/shipRenderer';
import { hexToRgba } from '../utils/colorUtils';

export interface SchematicSelection {
  readonly kitId: ShipKitId;
  readonly haulerUtility: HaulerUtilityId;
  readonly scoutUtility: ScoutUtilityId;
}

export const BOOST_COUPLING_DEMO_DURATION_MS = 3200;

const BOOST_COUPLING_ATTACH_START_MS = 220;
const BOOST_COUPLING_TURN_START_MS = 300;
const BOOST_COUPLING_TURN_END_MS = 800;
const BOOST_COUPLING_IGNITE_END_MS = 1100;
const BOOST_COUPLING_BOOST_END_MS = 1850;
const BOOST_COUPLING_FLAME_FADE_START_MS = 2600;
const BOOST_COUPLING_BOOST_DISTANCE = 52;
const DEMO_ASTEROID_RADIUS_FACTORS = {
  asymmetric: [1, 0.72, 0.92, 0.66, 1.08, 0.8, 0.9],
  default: [1, 0.78, 1, 0.78, 1, 0.78, 1, 0.78, 1],
} as const;

type BoostCouplingDemoFrame = {
  phase: 'idle' | 'turning' | 'igniting' | 'boosting' | 'coasting';
  rockX: number;
  rockY: number;
  rockAngle: number;
  cableVisible: boolean;
  headingVisible: boolean;
  flameStrength: number;
};

function resizeCanvas(canvas: HTMLCanvasElement, fallbackW: number, fallbackH: number): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || fallbackW));
  const height = Math.max(1, Math.round(rect.height || fallbackH));
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  closed: boolean
): void {
  const first = points[0];
  if (!first) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (point) {
      ctx.lineTo(point.x, point.y);
    }
  }
  if (closed) {
    ctx.closePath();
  }
  ctx.stroke();
}

function drawSchematicHull(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  kit: ShipKitId,
  selectedUtility: HaulerUtilityId
): void {
  const outline = getKitHullOutline(kit);
  const cx = width * 0.5;
  const cy = height * 0.46;
  const radius = Math.min(width, height) * 0.28;
  const angle = Math.PI / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = PALETTE.LOCAL;
  ctx.shadowColor = PALETTE.LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  strokePolyline(
    ctx,
    projectHullPolyline(cx, cy, radius, angle, outline.hull),
    outline.hull.closed
  );
  // Hull panels stay assembled and neutral; only the interchangeable tool is highlighted.
  for (const extra of outline.extras) {
    strokePolyline(ctx, projectHullPolyline(cx, cy, radius, angle, extra), extra.closed);
  }
  if (kit !== 'hauler') {
    return;
  }
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.shadowColor = PALETTE.LOOT;
  for (const part of getHaulerEquipment(selectedUtility)) {
    strokePolyline(ctx, projectHullPolyline(cx, cy, radius, angle, part), part.closed);
  }
  if (window.matchMedia('(max-width: 700px)').matches) {
    return;
  }
  // Every utility uses the same central mount.
  const mount = projectHullPoint(cx, cy, radius, angle, { f: 0.35, p: 0 });
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 0.65);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const slot = HAULER_UTILITY_IDS.indexOf(selectedUtility);
  ctx.moveTo((width * (slot + 0.5)) / HAULER_UTILITY_IDS.length, height);
  ctx.lineTo(mount.x, mount.y);
  ctx.stroke();
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function easeInOut(value: number): number {
  const t = clampUnit(value);
  return t * t * (3 - 2 * t);
}

function intervalProgress(elapsed: number, start: number, end: number): number {
  return clampUnit((elapsed - start) / (end - start));
}

export function getBoostCouplingDemoFrame(
  now: number,
  width: number,
  height: number
): BoostCouplingDemoFrame {
  const elapsed =
    ((now % BOOST_COUPLING_DEMO_DURATION_MS) + BOOST_COUPLING_DEMO_DURATION_MS) %
    BOOST_COUPLING_DEMO_DURATION_MS;
  const baseX = width * 0.64;
  const baseY = height * 0.5;
  const boostDistance = Math.min(BOOST_COUPLING_BOOST_DISTANCE, Math.max(24, width * 0.24));
  const attached = elapsed >= BOOST_COUPLING_ATTACH_START_MS;
  const turning = elapsed >= BOOST_COUPLING_TURN_START_MS && elapsed < BOOST_COUPLING_TURN_END_MS;
  const igniting = elapsed >= BOOST_COUPLING_TURN_END_MS && elapsed < BOOST_COUPLING_IGNITE_END_MS;
  const boosting = elapsed >= BOOST_COUPLING_IGNITE_END_MS && elapsed < BOOST_COUPLING_BOOST_END_MS;
  const movement = boosting
    ? easeInOut(
        intervalProgress(elapsed, BOOST_COUPLING_IGNITE_END_MS, BOOST_COUPLING_BOOST_END_MS)
      ) * boostDistance
    : elapsed >= BOOST_COUPLING_BOOST_END_MS
      ? boostDistance
      : 0;
  const fade = intervalProgress(
    elapsed,
    BOOST_COUPLING_FLAME_FADE_START_MS,
    BOOST_COUPLING_DEMO_DURATION_MS
  );
  return {
    phase: boosting
      ? 'boosting'
      : igniting
        ? 'igniting'
        : turning
          ? 'turning'
          : elapsed >= BOOST_COUPLING_BOOST_END_MS
            ? 'coasting'
            : 'idle',
    rockX: baseX + movement,
    rockY: baseY,
    rockAngle:
      turning || igniting
        ? easeInOut(
            intervalProgress(elapsed, BOOST_COUPLING_TURN_START_MS, BOOST_COUPLING_TURN_END_MS)
          ) *
          (Math.PI / 2)
        : elapsed >= BOOST_COUPLING_TURN_END_MS
          ? Math.PI / 2
          : 0,
    cableVisible: attached && elapsed < BOOST_COUPLING_TURN_END_MS,
    headingVisible: attached && elapsed < BOOST_COUPLING_TURN_END_MS,
    flameStrength: igniting
      ? intervalProgress(elapsed, BOOST_COUPLING_TURN_END_MS, BOOST_COUPLING_IGNITE_END_MS)
      : boosting
        ? 0.85 + Math.sin(now / 55) * 0.1
        : elapsed >= BOOST_COUPLING_BOOST_END_MS
          ? 0.6 * (1 - fade)
          : 0,
  };
}

function drawDemoAsteroid(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  angle: number,
  asymmetric = false
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  const radii = asymmetric
    ? DEMO_ASTEROID_RADIUS_FACTORS.asymmetric
    : DEMO_ASTEROID_RADIUS_FACTORS.default;
  for (let i = 0; i < radii.length; i++) {
    const vertexAngle = (i / (radii.length - 1)) * Math.PI * 2;
    const vertexRadius = radius * (radii[i] ?? 1);
    const vertexX = Math.cos(vertexAngle) * vertexRadius;
    const vertexY = Math.sin(vertexAngle) * vertexRadius;
    if (i === 0) {
      ctx.moveTo(vertexX, vertexY);
    } else {
      ctx.lineTo(vertexX, vertexY);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawBoostHeading(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x + 18, y);
  ctx.lineTo(x + 34, y);
  ctx.lineTo(x + 28, y - 4);
  ctx.moveTo(x + 34, y);
  ctx.lineTo(x + 28, y + 4);
  ctx.stroke();
}

function drawBoostFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  strength: number,
  now: number
): void {
  if (strength <= 0) {
    return;
  }
  const flicker = 0.9 + Math.sin(now / 45) * 0.1;
  const length = 11 + strength * 18 * flicker;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.LASER_LOCAL;
  ctx.shadowColor = PALETTE.LASER_LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  ctx.beginPath();
  ctx.moveTo(x - 12, y - 5);
  ctx.lineTo(x - 12 - length, y);
  ctx.lineTo(x - 12, y + 5);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.LOOT;
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(x - 13, y - 2.5);
  ctx.lineTo(x - 13 - length * 0.55, y);
  ctx.lineTo(x - 13, y + 2.5);
  ctx.stroke();
  ctx.restore();
}

function drawToolLoop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  now: number,
  kit: ShipKitId,
  selectedUtility: HaulerUtilityId,
  selectedScoutUtility: ScoutUtilityId
): void {
  ctx.clearRect(0, 0, width, height);
  if (kit === 'scout') {
    const shipX = width * 0.2;
    const midY = height * 0.5;
    const radius = 18;
    const elapsed = now % 2600;

    const rockX = width * 0.76 + Math.sin(now / 520) * 5;
    const rockY = midY + Math.sin(now / 680) * 4;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.LOCAL;
    ctx.shadowColor = PALETTE.LOCAL;
    ctx.shadowBlur = VISUAL.SHIP_GLOW;
    strokeKitHullOutline(ctx, shipX, midY, radius, 0, PALETTE.LOCAL, 'scout');
    ctx.shadowBlur = 0;
    ctx.strokeStyle = PALETTE.HUD_MUTED;
    drawDemoAsteroid(ctx, rockX, rockY, 13, now / 900);
    if (selectedScoutUtility === 'mineral_scan') {
      ctx.strokeStyle = PALETTE.LOOT;
      ctx.globalAlpha = 0.35 + pulse * 0.45;
      for (const ring of [14, 23, 32]) {
        ctx.beginPath();
        ctx.arc(shipX + 34, midY, ring + pulse * 3, -0.72, 0.72);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      const progress = Math.min(1, elapsed / 520);
      const probeX = shipX + radius + (rockX - shipX - radius) * progress;
      const probeY = midY + (rockY - 15 - midY) * progress;
      ctx.strokeStyle = PALETTE.LOOT;

      ctx.beginPath();
      ctx.moveTo(probeX, probeY - 7);
      ctx.lineTo(probeX + 7, probeY);
      ctx.lineTo(probeX, probeY + 7);
      ctx.lineTo(probeX - 7, probeY);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 0.28 + pulse * 0.42;
      ctx.beginPath();
      ctx.arc(probeX, probeY, 16 + pulse * 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    return;
  }
  const shipX = width * 0.22;
  const elapsed = now % 2600;
  const boostFrame =
    selectedUtility === 'boost_coupling'
      ? getBoostCouplingDemoFrame(now, width, height)
      : undefined;
  const attached = elapsed >= 250 && elapsed < 1850;
  const midY = height * 0.5;
  const radius = 19;
  const haul = selectedUtility === 'tow_cable' && attached ? ((elapsed - 250) / 1600) * 12 : 0;
  const kick = attached ? latchShudderOffset(elapsed - 250) : 0;
  const rockX = boostFrame?.rockX ?? width * 0.78 - haul + kick;
  const rockY = boostFrame?.rockY ?? midY + kick * 0.35;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.LOCAL;
  ctx.shadowColor = PALETTE.LOCAL;
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  strokeKitHullOutline(ctx, shipX, midY, radius, 0, PALETTE.LOCAL, 'hauler', selectedUtility);
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.shadowBlur = 0;
  drawDemoAsteroid(ctx, rockX, rockY, 14, boostFrame?.rockAngle ?? 0, boostFrame !== undefined);
  if (selectedUtility === 'boost_coupling' && boostFrame?.cableVisible) {
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    ctx.moveTo(shipX + radius * 0.72, midY);
    ctx.lineTo(rockX - 14, rockY);
    ctx.stroke();
  } else if (
    (attached || (elapsed < 250 && selectedUtility === 'tow_cable')) &&
    selectedUtility !== 'boost_coupling'
  ) {
    ctx.strokeStyle = PALETTE.LOOT;
    ctx.beginPath();
    ctx.moveTo(shipX + radius * 0.72, midY);
    const tipX =
      selectedUtility === 'tow_cable' && elapsed < 250
        ? shipX + radius + ((rockX - 14 - shipX - radius) * elapsed) / 250
        : rockX - 14;
    ctx.lineTo(tipX, rockY);
    ctx.stroke();
  }
  if (selectedUtility === 'boost_coupling') {
    ctx.strokeStyle = PALETTE.LOOT;
    if (boostFrame?.headingVisible) {
      drawBoostHeading(ctx, rockX, rockY);
    }
    drawBoostFlame(ctx, rockX, rockY, boostFrame?.flameStrength ?? 0, now);
  } else if (selectedUtility === 'resource_tap') {
    const extractMs = (SHIP_ABILITY.TAP_EXTRACT_FRAMES / 60) * 1000;
    for (let i = 0; i < SHIP_ABILITY.TAP_EXTRACT_BURSTS; i++) {
      const age = elapsed - 250 - ((i + 1) * extractMs) / SHIP_ABILITY.TAP_EXTRACT_BURSTS;
      if (age < 0 || age > 700) {
        continue;
      }
      const angle = -0.9 + i * 0.6;
      const travel = 13 + age * 0.045;
      const x = rockX + Math.cos(angle) * travel;
      const y = midY + Math.sin(angle) * travel;
      ctx.globalAlpha = 1 - age / 700;
      ctx.strokeStyle = PALETTE.LOOT;
      ctx.beginPath();
      traceTapCanister(ctx, x, y, 5);
      ctx.stroke();
      ctx.strokeStyle = PALETTE.LASER_LOCAL;
      ctx.beginPath();
      ctx.moveTo(x - 1, y - 3.9);
      ctx.lineTo(x + 1, y - 3.9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function paintShipSchematicCanvases(
  hullCanvas: HTMLCanvasElement,
  toolCanvas: HTMLCanvasElement,
  selection: SchematicSelection,
  now: number
): void {
  resizeCanvas(hullCanvas, 640, 360);
  resizeCanvas(toolCanvas, 220, 80);
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const hull = hullCanvas.getContext('2d');
  const tool = toolCanvas.getContext('2d');
  if (hull) {
    hull.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSchematicHull(
      hull,
      hullCanvas.width / dpr,
      hullCanvas.height / dpr,
      selection.kitId,
      selection.haulerUtility
    );
  }
  if (tool) {
    tool.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawToolLoop(
      tool,
      toolCanvas.width / dpr,
      toolCanvas.height / dpr,
      now,
      selection.kitId,
      selection.haulerUtility,
      selection.scoutUtility
    );
  }
}

/** The active Svelte panel owns this painter's lifetime, never simulation state. */
export function mountShipSchematicCanvases(
  hull: HTMLCanvasElement,
  tool: HTMLCanvasElement,
  readSelection: () => SchematicSelection
): { refresh(): void; dispose(): void } {
  let disposed = false;
  let pending: number | undefined;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scope = new AbortController();
  const cancel = () => {
    if (pending !== undefined) {
      window.cancelAnimationFrame(pending);
      pending = undefined;
    }
  };
  const paint = (now: number) => {
    if (disposed) {
      return;
    }
    pending = undefined;
    if (document.hidden) {
      return;
    }
    paintShipSchematicCanvases(hull, tool, readSelection(), reducedMotion.matches ? 0 : now);
    if (!reducedMotion.matches) {
      pending = window.requestAnimationFrame(paint);
    }
  };
  const refresh = () => {
    cancel();
    paint(performance.now());
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh);
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    cancel();
    scope.abort();
    reducedMotion.removeEventListener('change', refresh);
    observer?.disconnect();
  };
  try {
    document.addEventListener('visibilitychange', refresh, { signal: scope.signal });
    window.addEventListener('resize', refresh, { signal: scope.signal });
    reducedMotion.addEventListener('change', refresh);
    observer?.observe(hull);
    observer?.observe(tool);
    refresh();
    return { refresh, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
