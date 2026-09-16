import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { FURNACES } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getWorldExploration } from '../network/worldExploration';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';
import type { DrawingContext } from './drawingContext';
import { resolveGlow } from './renderQuality';
import { strokePhosphorPolyline, type Vec2 } from './vectorJuice';

const furnaceScreen = { x: 0, y: 0 };
const FURNACE_COLOR = PALETTE.SATELLITE;
const FURNACE_LABEL_COLOR = PALETTE.HUD;
/** Contour samples per flame edge; enough for a curling tongue, few enough to stay hairline. */
const FLAME_STEPS = 18;
const EMBER_COUNT = 5;

interface FlameTongue {
  /** Flame height and belly width, both in furnace radii. */
  readonly heightScale: number;
  readonly halfWidthScale: number;
  /** Fixed lateral offset of the tongue root, in furnace radii. */
  readonly lean: number;
  /** Lateral travel of the tip, in flame heights. */
  readonly sway: number;
  readonly speed: number;
  readonly phase: number;
  readonly color: string;
  readonly alpha: number;
  readonly widthScale: number;
  readonly glowScale: number;
}

/** Overlapping tongues of different heights read as fire rather than one chevron. */
const FLAME_TONGUES: readonly FlameTongue[] = [
  {
    heightScale: 1.28,
    halfWidthScale: 0.62,
    lean: 0,
    sway: 0.06,
    speed: 0.85,
    phase: 0,
    color: PALETTE.LOOT,
    alpha: 0.34,
    widthScale: 1.5,
    glowScale: 1.7,
  },
  {
    heightScale: 1.14,
    halfWidthScale: 0.44,
    lean: -0.02,
    sway: 0.08,
    speed: 1.2,
    phase: 0.8,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.95,
    widthScale: 1.15,
    glowScale: 1.3,
  },
  {
    heightScale: 0.94,
    halfWidthScale: 0.26,
    lean: -0.28,
    sway: 0.13,
    speed: 1.65,
    phase: 2.1,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.82,
    widthScale: 0.95,
    glowScale: 1,
  },
  {
    heightScale: 0.86,
    halfWidthScale: 0.24,
    lean: 0.3,
    sway: 0.14,
    speed: 1.5,
    phase: 3.9,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.82,
    widthScale: 0.95,
    glowScale: 1,
  },
  {
    heightScale: 0.74,
    halfWidthScale: 0.18,
    lean: -0.13,
    sway: 0.12,
    speed: 1.9,
    phase: 4.6,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.7,
    widthScale: 0.85,
    glowScale: 0.95,
  },
  {
    heightScale: 0.68,
    halfWidthScale: 0.17,
    lean: 0.14,
    sway: 0.12,
    speed: 2.15,
    phase: 0.4,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.7,
    widthScale: 0.85,
    glowScale: 0.95,
  },
  {
    heightScale: 0.6,
    halfWidthScale: 0.4,
    lean: 0.01,
    sway: 0.05,
    speed: 2.05,
    phase: 1.3,
    color: PALETTE.LASER_LOCAL,
    alpha: 1,
    widthScale: 0.9,
    glowScale: 1.15,
  },
  {
    heightScale: 0.58,
    halfWidthScale: 0.14,
    lean: -0.47,
    sway: 0.17,
    speed: 2.3,
    phase: 5.2,
    color: PALETTE.LOOT,
    alpha: 0.5,
    widthScale: 0.8,
    glowScale: 0.9,
  },
  {
    heightScale: 0.5,
    halfWidthScale: 0.13,
    lean: 0.49,
    sway: 0.18,
    speed: 2.5,
    phase: 6.4,
    color: PALETTE.LOOT,
    alpha: 0.5,
    widthScale: 0.8,
    glowScale: 0.9,
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
  for (const furnace of FURNACES) {
    const cell = explorationCellAt(furnace.position);
    if (cell === null || !isCellExplored(exploration, cell)) {
      continue;
    }
    const screen = canvasManager.worldToScreenInto(furnaceScreen, furnace.position, viewerPosition);
    const radius = furnace.radius * scale;
    const cull = radius * 2;
    if (
      screen.x < -cull ||
      screen.y < -cull ||
      screen.x > viewport.width + cull ||
      screen.y > viewport.height + cull
    ) {
      continue;
    }
    drawFurnaceArtwork(ctx, screen.x, screen.y, radius, now);
    drawFurnaceLabel(ctx, screen.x, screen.y, radius, furnace.name);
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

  const mouthY = y + radius * 0.34;
  strokeFireBed(ctx, x, mouthY, radius, line);
  strokeFlames(ctx, x, mouthY, radius, seconds);
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
  const half = radius * 0.62;
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
  for (let index = 0; index < 7; index += 1) {
    const grateX = x - half * 0.84 + (index * half * 1.68) / 6;
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
  radius: number,
  seconds: number
): void {
  for (const tongue of FLAME_TONGUES) {
    const roar =
      0.86 +
      Math.sin(seconds * 6.1 + tongue.phase) * 0.1 +
      Math.sin(seconds * 11.3 + tongue.phase * 1.9) * 0.06;
    const contour = flameContour(
      x + radius * tongue.lean,
      mouthY,
      radius * tongue.heightScale * roar,
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
 * leans further the higher it climbs. Both edges carry their own ripple so the
 * tongue never looks like a mirrored chevron.
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
    const width = halfWidth * (1 - along) ** 0.72 * belly;
    const rise = along ** 1.45;
    const drift =
      Math.sin(rise * 3.1 + seconds * tongue.speed * 2 + tongue.phase) * 0.62 +
      Math.sin(rise * 6.3 - seconds * tongue.speed * 3.1 + tongue.phase * 1.7) * 0.26;
    const lateral = height * tongue.sway * rise * drift;
    const y = rootY - height * along;
    left.push({
      x: rootX + lateral - width + width * 0.18 * Math.sin(along * 11 + seconds * 3 + tongue.phase),
      y,
    });
    right.push({
      x:
        rootX +
        lateral +
        width +
        width * 0.18 * Math.sin(along * 9.5 - seconds * 3.6 + tongue.phase * 2.3),
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
    const rise = (seconds * 0.42 + index / EMBER_COUNT) % 1;
    const emberY = mouthY - radius * (0.9 + rise * 0.9);
    const emberX =
      x + radius * (0.3 * rise * Math.sin(phase + rise * 3.4) + 0.08 * Math.sin(phase));
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
  name: string
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
  ctx.fillText('DELIVERY ZONE', x, y + radius + 7);
  ctx.restore();
}
