import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { CIVIC_LOTS, pipeHopToParent, TOWN_HEARTH } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { activeFurnacePipePulses, furnacePipeFrame } from '../fx/furnacePipePulse';
import { getSettlement, getWorldExploration, worldFurnaces } from '../network/worldExploration';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvasSurface';
import type { DrawingContext } from './drawingContext';
import { resolveGlow } from './renderQuality';
import { strokePhosphorPolyline, type Vec2 } from './vectorJuice';

const furnaceScreen = { x: 0, y: 0 };
const pipeHead = { x: 0, y: 0 };
const PIPE_SCREEN: Array<{ x: number; y: number }> = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];
const TRAIL_SCREEN: Array<{ x: number; y: number }> = [];
const trailEmber = { x: 0, y: 0 };
const FURNACE_COLOR = PALETTE.SATELLITE;
const FURNACE_LABEL_COLOR = PALETTE.HUD;
/** Contour samples per flame edge; enough for a curling tongue, few enough to stay hairline. */
const FLAME_STEPS = 18;
const EMBER_COUNT = 7;
/** Largest stretch the tip snap can add, used to keep surges under the name plate. */
const FLAME_SNAP_CEILING = 1.13;

interface FlameTongue {
  /** Flame height and belly width, both in furnace radii. */
  readonly heightScale: number;
  readonly halfWidthScale: number;
  /** Fixed lateral offset of the tongue root, in furnace radii. */
  readonly lean: number;
  /** Lateral travel of the tip, in flame heights. */
  readonly sway: number;
  /** Sideways bow at mid-height, in flame heights; bends a tongue into a vortex. */
  readonly curl: number;
  readonly speed: number;
  readonly phase: number;
  readonly color: string;
  readonly alpha: number;
  readonly widthScale: number;
  readonly glowScale: number;
}

/**
 * A blast-furnace draft: one narrow column roaring straight up the intake, two
 * vortices curling off its base, and a bright pool of fire on the grate. Few
 * tongues on purpose — a thicket averages out into a silhouette that never
 * appears to move.
 */
const FLAME_TONGUES: readonly FlameTongue[] = [
  {
    heightScale: 1.16,
    halfWidthScale: 0.31,
    lean: 0,
    sway: 0.05,
    curl: 0,
    speed: 1.09,
    phase: 0.31,
    color: PALETTE.LOOT,
    alpha: 0.3,
    widthScale: 1.5,
    glowScale: 1.7,
  },
  {
    heightScale: 1.14,
    halfWidthScale: 0.19,
    lean: 0,
    sway: 0.08,
    curl: 0.03,
    speed: 1.53,
    phase: 1.43,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.95,
    widthScale: 1.2,
    glowScale: 1.35,
  },
  {
    heightScale: 0.78,
    halfWidthScale: 0.14,
    lean: -0.21,
    sway: 0.3,
    curl: -0.16,
    speed: 2.41,
    phase: 3.27,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.78,
    widthScale: 1,
    glowScale: 1.1,
  },
  {
    heightScale: 0.72,
    halfWidthScale: 0.13,
    lean: 0.22,
    sway: 0.32,
    curl: 0.17,
    speed: 2.19,
    phase: 5.02,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.78,
    widthScale: 1,
    glowScale: 1.1,
  },
  {
    heightScale: 0.42,
    halfWidthScale: 0.28,
    lean: 0,
    sway: 0.06,
    curl: 0,
    speed: 2.63,
    phase: 2.07,
    color: PALETTE.LASER_LOCAL,
    alpha: 1,
    widthScale: 0.95,
    glowScale: 1.2,
  },
];

/** Known station artwork; the ring marks a delivery zone and has no physics. */
export function drawFurnacesRelative(viewerPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const exploration = getWorldExploration();
  const now = performance.now();
  for (const furnace of worldFurnaces.nearby(
    viewerPosition,
    Math.hypot(viewport.width, viewport.height) / scale + 200
  )) {
    const cell = explorationCellAt(furnace.position);
    if (cell === null || !isCellExplored(exploration, cell)) {
      continue;
    }
    const screen = canvasManager.worldToScreenInto(furnaceScreen, furnace.position, viewerPosition);
    const radius = furnace.radius * scale;
    const cull = radius * 5;
    if (
      screen.x < -cull ||
      screen.y < -cull ||
      screen.x > viewport.width + cull ||
      screen.y > viewport.height + cull
    ) {
      continue;
    }
    if (furnace.id === TOWN_HEARTH.id) {
      drawDockingStation(ctx, screen.x, screen.y, radius, getSettlement().level);
    }
    drawFurnaceArtwork(ctx, screen.x, screen.y, radius, now);
    drawFurnaceLabel(
      ctx,
      screen.x,
      screen.y,
      radius,
      furnace.name,
      furnace.id === TOWN_HEARTH.id ? 'STORE' : 'DELIVERY ZONE'
    );
  }
}

/** Playfield furnace mark: a dashed intake around a blazing open hearth. */
export function drawFurnaceArtwork(
  ctx: DrawingContext,
  x: number,
  y: number,
  radius: number,
  now: number
): void {
  if (!(radius > 0) || !Number.isFinite(radius)) {
    return;
  }

  const seconds = now / 1000;
  const pulse = 0.78 + Math.sin(now / 850) * 0.12;
  const line = Math.max(1, Math.min(2, radius * 0.018));

  ctx.save();
  ctx.fillStyle = hexToRgba(FURNACE_COLOR, 0.045);
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.32);
  ctx.shadowColor = FURNACE_COLOR;
  ctx.shadowBlur = resolveGlow(VISUAL.FURNACE_GLOW);
  ctx.lineWidth = line;
  ctx.stroke();

  ctx.setLineDash([Math.max(4, radius * 0.1), Math.max(3, radius * 0.06)]);
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.75 * pulse);
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.88, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const mouthY = y + radius * 0.42;
  strokeFireBed(ctx, x, mouthY, radius, line);
  strokeFlames(ctx, x, mouthY, y - radius, radius, seconds);
  strokeEmbers(ctx, x, mouthY, radius, seconds, line);
}

/** Open fire bed the tongues rise from; the flat lip keeps the flame grounded. */
function strokeFireBed(
  ctx: DrawingContext,
  x: number,
  mouthY: number,
  radius: number,
  line: number
): void {
  const half = radius * 0.36;
  strokePhosphorPolyline(
    ctx,
    [
      { x: x - half * 1.24, y: mouthY + radius * 0.1 },
      { x: x - half, y: mouthY },
      { x: x + half, y: mouthY },
      { x: x + half * 1.24, y: mouthY + radius * 0.1 },
    ],
    FURNACE_COLOR,
    Math.max(line, VISUAL.FURNACE_STROKE_WIDTH),
    VISUAL.FURNACE_GLOW,
    false,
    0.8
  );

  ctx.save();
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.42);
  ctx.shadowColor = FURNACE_COLOR;
  ctx.shadowBlur = resolveGlow(VISUAL.FURNACE_GLOW);
  ctx.lineWidth = line;
  for (let index = 0; index < 5; index += 1) {
    const grateX = x - half * 0.84 + (index * half * 1.68) / 4;
    ctx.beginPath();
    ctx.moveTo(grateX, mouthY + radius * 0.02);
    ctx.lineTo(grateX, mouthY + radius * 0.09);
    ctx.stroke();
  }
  ctx.restore();
}

function strokeFlames(
  ctx: DrawingContext,
  x: number,
  mouthY: number,
  top: number,
  radius: number,
  seconds: number
): void {
  for (const tongue of FLAME_TONGUES) {
    // Three detuned breaths per tongue. The rates share no common multiple, so
    // the draft surges and gutters for minutes without repeating a pose.
    const roar =
      0.84 +
      Math.sin(seconds * 4.61 + tongue.phase) * 0.26 +
      Math.sin(seconds * 7.93 + tongue.phase * 1.7) * 0.12 +
      Math.sin(seconds * 1.27 + tongue.phase * 2.3) * 0.08;
    // The draft may surge to the intake ring, never through the station's name.
    const ceiling = (mouthY - top) / FLAME_SNAP_CEILING;
    const contour = flameContour(
      x + radius * tongue.lean,
      mouthY,
      Math.min(radius * tongue.heightScale * roar, ceiling),
      radius * tongue.halfWidthScale,
      tongue,
      seconds
    );
    strokePhosphorPolyline(
      ctx,
      contour,
      tongue.color,
      VISUAL.FURNACE_FLAME_STROKE_WIDTH * tongue.widthScale,
      VISUAL.FURNACE_FLAME_GLOW * tongue.glowScale,
      true,
      tongue.alpha
    );
  }
}

/**
 * Teardrop flame outline: a narrow root, a low belly, and a drawn-out tip that
 * leans further the higher it climbs. Both edges carry their own ripple, and the
 * tip snaps on a faster clock than the body, so a tongue never looks like a
 * mirrored chevron gliding through a sine wave.
 */
function flameContour(
  rootX: number,
  rootY: number,
  height: number,
  halfWidth: number,
  tongue: FlameTongue,
  seconds: number
): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let step = 0; step <= FLAME_STEPS; step += 1) {
    const along = step / FLAME_STEPS;
    const belly = 0.38 + 0.62 * Math.sin(Math.PI * Math.min(1, along * 2));
    const rise = along ** 1.45;
    // Tips whip and pinch; the root stays anchored on the grate. The width
    // snaps harder than the reach so a lick can thin out without shooting up.
    const jitter =
      Math.sin(seconds * 9.7 + tongue.phase * 3.1 + along * 5.3) * 0.22 +
      Math.sin(seconds * 16.3 - tongue.phase * 2.2 + along * 9.1) * 0.11;
    const width = halfWidth * (1 - along) ** 0.72 * belly * (1 + rise * jitter);
    const reach = 1 + rise * jitter * 0.4;
    const drift =
      Math.sin(rise * 3.1 + seconds * tongue.speed * 3.07 + tongue.phase) * 0.68 +
      Math.sin(rise * 6.3 - seconds * tongue.speed * 4.73 + tongue.phase * 1.7) * 0.3;
    const bow = Math.sin(Math.PI * along) * tongue.curl;
    const lateral = height * (tongue.sway * rise * drift + bow);
    const y = rootY - height * along * reach;
    left.push({
      x:
        rootX +
        lateral -
        width +
        width * 0.26 * Math.sin(along * 11 + seconds * 4.37 + tongue.phase),
      y,
    });
    right.push({
      x:
        rootX +
        lateral +
        width +
        width * 0.26 * Math.sin(along * 9.5 - seconds * 5.11 + tongue.phase * 2.3),
      y,
    });
  }

  const contour = left;
  for (let step = FLAME_STEPS - 1; step >= 0; step -= 1) {
    const point = right[step];
    if (point !== undefined) {
      contour.push(point);
    }
  }
  return contour;
}

/** Sparks lifting off the fire; they fade as they climb past the intake. */
function strokeEmbers(
  ctx: DrawingContext,
  x: number,
  mouthY: number,
  radius: number,
  seconds: number,
  line: number
): void {
  ctx.save();
  ctx.shadowColor = PALETTE.LOOT;
  ctx.shadowBlur = resolveGlow(VISUAL.FURNACE_FLAME_GLOW);
  ctx.lineWidth = line;
  for (let index = 0; index < EMBER_COUNT; index += 1) {
    const phase = index * 1.37;
    // Each spark climbs at its own rate and wanders on its own draft, so the
    // stream never marches in step.
    const rise = (seconds * (0.38 + index * 0.031) + index / EMBER_COUNT) % 1;
    const wander =
      Math.sin(phase + rise * 3.4) * 0.19 + Math.sin(phase * 2.6 + rise * 7.1 + seconds) * 0.09;
    const emberY = mouthY - radius * (0.72 + rise * (1.05 + 0.2 * Math.sin(phase * 1.9)));
    const emberX = x + radius * (rise * wander + 0.07 * Math.sin(phase));
    ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 0.5 * (1 - rise));
    ctx.beginPath();
    ctx.arc(emberX, emberY, Math.max(1, radius * 0.022 * (1 - rise)), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFurnaceLabel(
  ctx: DrawingContext,
  x: number,
  y: number,
  radius: number,
  name: string,
  subtitle = 'DELIVERY ZONE'
): void {
  ctx.save();
  ctx.fillStyle = hexToRgba(FURNACE_LABEL_COLOR, 0.82);
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(name, x, y - radius - 7);
  ctx.fillStyle = hexToRgba(FURNACE_COLOR, 0.72);
  ctx.font = '9px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(subtitle, x, y + radius + 7);
  ctx.restore();
}

function segmentNear(viewer: Position, start: Position, end: Position, reach: number): boolean {
  const abx = end.x - start.x;
  const aby = end.y - start.y;
  const lengthSquared = abx * abx + aby * aby;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((viewer.x - start.x) * abx + (viewer.y - start.y) * aby) / lengthSquared)
        );
  const dx = viewer.x - (start.x + abx * t);
  const dy = viewer.y - (start.y + aby * t);
  return dx * dx + dy * dy <= reach * reach;
}

function polylineLength(points: readonly Position[], count: number): number {
  let length = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    length += Math.hypot(end.x - start.x, end.y - start.y);
  }
  return length;
}

function pointAlongInto(
  out: Position,
  points: readonly Position[],
  count: number,
  distance: number
): void {
  let remaining = Math.max(0, distance);
  for (let index = 0; index < count - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    const span = Math.hypot(end.x - start.x, end.y - start.y);
    if (remaining <= span || index === count - 2) {
      const t = span === 0 ? 1 : Math.min(1, remaining / span);
      out.x = start.x + (end.x - start.x) * t;
      out.y = start.y + (end.y - start.y) * t;
      return;
    }
    remaining -= span;
  }
  const last = points[count - 1];
  out.x = last?.x ?? 0;
  out.y = last?.y ?? 0;
}

function tracePolyline(ctx: DrawingContext, points: readonly Position[], count: number): void {
  const first = points[0];
  if (!first) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < count; index += 1) {
    const point = points[index];
    if (point) {
      ctx.lineTo(point.x, point.y);
    }
  }
}

/**
 * A burning furnace's pipeline: a hot core with embers running toward Town Square.
 * `points` uses the caller's coordinate space. `width` and `glow` use that same space.
 */
export function strokeFurnaceFireTrail(
  ctx: DrawingContext,
  points: readonly Position[],
  count: number,
  now: number,
  width: number,
  glow: number,
  emberSpacing: number
): void {
  if (count < 2 || !(width > 0)) {
    return;
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.shadowColor = PALETTE.LASER_LOCAL;
  ctx.shadowBlur = glow;
  tracePolyline(ctx, points, count);
  ctx.strokeStyle = hexToRgba(PALETTE.DANGER, 0.72);
  ctx.lineWidth = width * 2.6;
  ctx.stroke();
  ctx.strokeStyle = hexToRgba(PALETTE.LASER_LOCAL, 0.95);
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.strokeStyle = hexToRgba(PALETTE.LOOT, 1);
  ctx.lineWidth = Math.max(1, width * 0.45);
  ctx.stroke();
  const length = polylineLength(points, count);
  if (length > 0 && emberSpacing > 0) {
    const phase = ((now / 1000) * emberSpacing * 0.85) % emberSpacing;
    const radius = width * 0.9;
    ctx.shadowBlur = glow * 0.65;
    for (let distance = phase; distance < length; distance += emberSpacing) {
      pointAlongInto(trailEmber, points, count, distance);
      ctx.fillStyle = hexToRgba(
        Math.floor(distance / emberSpacing) % 2 === 0 ? PALETTE.LASER_LOCAL : PALETTE.LOOT,
        0.95
      );
      ctx.beginPath();
      ctx.arc(trailEmber.x, trailEmber.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function hopNear(viewer: Position, points: readonly Position[], reach: number): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start && end && segmentNear(viewer, start, end, reach)) {
      return true;
    }
  }
  return false;
}

function projectHop(viewer: Position, world: readonly Position[]): number {
  while (TRAIL_SCREEN.length < world.length) {
    TRAIL_SCREEN.push({ x: 0, y: 0 });
  }
  for (let index = 0; index < world.length; index += 1) {
    const point = world[index];
    const screen = TRAIL_SCREEN[index];
    if (!point || !screen) {
      continue;
    }
    canvasManager.worldToScreenInto(screen, point, viewer);
  }
  return world.length;
}

/**
 * Lit furnaces show a fire trail along the right-angle pipeline back to Town Square.
 * A delivery sends one brighter head along that same run.
 */
export function drawFurnacePipes(viewerPosition: Position, now = performance.now()): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const reach = Math.hypot(viewport.width, viewport.height) / scale + 200;
  ctx.save();
  // Keep both the standing fire trail and delivery pulses outside every hearth.
  // The ring is drawn afterward, so each pipe meets its rim without covering the flame.
  ctx.beginPath();
  ctx.rect(0, 0, viewport.width, viewport.height);
  for (const furnace of worldFurnaces.nearby(viewerPosition, reach)) {
    const screen = canvasManager.worldToScreenInto(furnaceScreen, furnace.position, viewerPosition);
    const radius = furnace.radius * scale;
    ctx.moveTo(screen.x + radius, screen.y);
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  }
  ctx.clip('evenodd');
  ctx.setLineDash([]);
  for (const lot of CIVIC_LOTS) {
    if (!worldFurnaces.isLit(lot.id)) {
      continue;
    }
    const hop = pipeHopToParent(lot.id);
    if (hop.length < 2 || !hopNear(viewerPosition, hop, reach)) {
      continue;
    }
    const count = projectHop(viewerPosition, hop);
    strokeFurnaceFireTrail(
      ctx,
      TRAIL_SCREEN,
      count,
      now,
      2.2,
      resolveGlow(VISUAL.FURNACE_FLAME_GLOW),
      28
    );
  }
  for (const pulse of activeFurnacePipePulses(now)) {
    const frame = furnacePipeFrame(pulse, now);
    if (!frame) {
      continue;
    }
    let visible = false;
    for (let index = 0; index < pulse.points.length - 1; index += 1) {
      const start = pulse.points[index];
      const end = pulse.points[index + 1];
      if (start && end && segmentNear(viewerPosition, start, end, reach)) {
        visible = true;
        break;
      }
    }
    if (!visible) {
      continue;
    }
    while (PIPE_SCREEN.length < pulse.points.length) {
      PIPE_SCREEN.push({ x: 0, y: 0 });
    }
    const count = pulse.points.length;
    for (let index = 0; index < count; index += 1) {
      const world = pulse.points[index];
      const screen = PIPE_SCREEN[index];
      if (!world || !screen) {
        continue;
      }
      canvasManager.worldToScreenInto(screen, world, viewerPosition);
    }
    ctx.save();
    ctx.shadowColor = PALETTE.LASER_LOCAL;
    ctx.shadowBlur = resolveGlow(VISUAL.FURNACE_FLAME_GLOW);
    ctx.strokeStyle = hexToRgba(PALETTE.LASER_LOCAL, 0.9 * frame.alpha);
    ctx.lineWidth = 3;
    ctx.beginPath();
    const first = PIPE_SCREEN[0];
    if (first) {
      ctx.moveTo(first.x, first.y);
    }
    for (let index = 1; index < count; index += 1) {
      const screen = PIPE_SCREEN[index];
      if (screen) {
        ctx.lineTo(screen.x, screen.y);
      }
    }
    ctx.stroke();
    canvasManager.worldToScreenInto(pipeHead, frame.head, viewerPosition);
    ctx.fillStyle = hexToRgba(PALETTE.LOOT, frame.alpha);
    ctx.beginPath();
    ctx.arc(pipeHead.x, pipeHead.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Dark furnace lots. A dashed ring with no flame until a Scout builds it. */
export function drawFurnaceFoundations(viewerPosition: Position): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const reach = Math.hypot(viewport.width, viewport.height) / scale + 200;
  for (const lot of CIVIC_LOTS) {
    if (worldFurnaces.isLit(lot.id)) {
      continue;
    }
    if (Math.hypot(lot.position.x - viewerPosition.x, lot.position.y - viewerPosition.y) > reach) {
      continue;
    }
    const screen = canvasManager.worldToScreenInto(furnaceScreen, lot.position, viewerPosition);
    const radius = lot.radius * scale;
    const cull = radius * 5;
    if (
      screen.x < -cull ||
      screen.y < -cull ||
      screen.x > viewport.width + cull ||
      screen.y > viewport.height + cull
    ) {
      continue;
    }
    ctx.save();
    ctx.setLineDash([Math.max(4, radius * 0.12), Math.max(3, radius * 0.08)]);
    ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.45);
    ctx.lineWidth = Math.max(1, radius * 0.02);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawFurnaceLabel(
      ctx,
      screen.x,
      screen.y,
      radius,
      lot.name,
      `SCORE ${lot.cost.toLocaleString('en-US')}`
    );
  }
}

/** Docking arms and habitat rings grow around the original intake. */
function drawDockingStation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  level: number
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#91A7C0';
  ctx.fillStyle = '#111C2B';
  ctx.lineWidth = 1.5;
  const r = radius * 1.6;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    const px = Math.cos(angle) * r;
    const py = Math.sin(angle) * r;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const arms = Math.min(12, 2 + level * 2);
  for (let i = 0; i < arms; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI * 2) / arms);
    const length = radius * (0.8 + Math.min(level, 8) * 0.18);
    ctx.fillRect(r - 4, -radius * 0.2, length, radius * 0.4);
    ctx.strokeRect(r - 4, -radius * 0.2, length, radius * 0.4);
    ctx.strokeStyle = '#7DE8D4';
    ctx.strokeRect(r + length - radius * 0.15, -radius * 0.33, radius * 0.25, radius * 0.66);
    if (level >= 3) {
      ctx.strokeStyle = '#647E9A';
      ctx.strokeRect(r + length * 0.3, -radius * 0.7, radius * 0.45, radius * 0.35);
      ctx.strokeRect(r + length * 0.3, radius * 0.35, radius * 0.45, radius * 0.35);
    }
    ctx.restore();
  }
  if (level >= 2) {
    ctx.strokeStyle = '#4D6C86';
    ctx.beginPath();
    ctx.arc(0, 0, r + radius * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
