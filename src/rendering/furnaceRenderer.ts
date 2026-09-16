import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { FURNACES } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { getWorldExploration } from '../network/worldExploration';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';
import type { DrawingContext } from './drawingContext';
import { resolveGlow } from './renderQuality';
import { strokePhosphorPolyline, thrusterFlameGeometry, type Vec2 } from './vectorJuice';

const furnaceScreen = { x: 0, y: 0 };
const FURNACE_COLOR = PALETTE.SATELLITE;
const FURNACE_LABEL_COLOR = PALETTE.HUD;
const FURNACE_FLAME_UP = -Math.PI / 2;
const THRUSTER_HALF_WIDTH_RATIO = 0.2;

interface HearthTongue {
  readonly angle: number;
  readonly halfWidth: number;
  readonly lengthScale: number;
  readonly phase: number;
  readonly color: string;
  readonly alpha: number;
  readonly widthScale: number;
  readonly glowScale: number;
}

/** Same open-V family as ship thrust, scaled until the plume fills the intake. */
const HEARTH_TONGUES: readonly HearthTongue[] = [
  {
    angle: FURNACE_FLAME_UP,
    halfWidth: 0.56,
    lengthScale: 1.22,
    phase: 0,
    color: PALETTE.LOOT,
    alpha: 0.46,
    widthScale: 1.45,
    glowScale: 1.55,
  },
  {
    angle: FURNACE_FLAME_UP,
    halfWidth: 0.42,
    lengthScale: 1.08,
    phase: 0.2,
    color: PALETTE.LASER_LOCAL,
    alpha: 1,
    widthScale: 1.2,
    glowScale: 1.2,
  },
  {
    angle: FURNACE_FLAME_UP,
    halfWidth: 0.24,
    lengthScale: 0.7,
    phase: 0.55,
    color: PALETTE.LASER_LOCAL,
    alpha: 0.95,
    widthScale: 0.9,
    glowScale: 0.95,
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
    const cull = radius + 36;
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

/** Playfield furnace mark: dashed intake plus a roaring ship-style hearth flame. */
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

  strokeKilnCollar(ctx, x, y, radius, line);
  strokeHearthFlames(ctx, x, y, radius, now);
}

function strokeKilnCollar(
  ctx: DrawingContext,
  x: number,
  y: number,
  radius: number,
  line: number
): void {
  const kiln = radius * 0.36;
  const points: Vec2[] = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = Math.PI / 8 + (index * Math.PI * 2) / 8;
    points.push({
      x: x + Math.cos(angle) * kiln,
      y: y + Math.sin(angle) * kiln,
    });
  }
  strokePhosphorPolyline(
    ctx,
    points,
    FURNACE_COLOR,
    Math.max(line, VISUAL.FURNACE_STROKE_WIDTH),
    VISUAL.FURNACE_GLOW,
    true,
    0.82
  );

  ctx.save();
  ctx.strokeStyle = hexToRgba(FURNACE_COLOR, 0.55);
  ctx.shadowColor = FURNACE_COLOR;
  ctx.shadowBlur = resolveGlow(VISUAL.FURNACE_GLOW);
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(x, y + radius * 0.26, Math.max(3, radius * 0.08), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function strokeHearthFlames(
  ctx: DrawingContext,
  x: number,
  y: number,
  radius: number,
  now: number
): void {
  const rear = { x, y: y + radius * 0.26 };
  for (const tongue of HEARTH_TONGUES) {
    const flame = tongueGeometry(rear, radius, tongue, now);
    strokePhosphorPolyline(
      ctx,
      [flame.left, flame.tip, flame.right],
      tongue.color,
      VISUAL.FURNACE_FLAME_STROKE_WIDTH * tongue.widthScale,
      VISUAL.FURNACE_FLAME_GLOW * tongue.glowScale,
      false,
      tongue.alpha
    );
    strokePhosphorPolyline(
      ctx,
      [flame.coreLeft, flame.coreTip, flame.coreRight],
      tongue.color,
      VISUAL.FURNACE_FLAME_STROKE_WIDTH * tongue.widthScale * 0.75,
      VISUAL.FURNACE_FLAME_GLOW * tongue.glowScale * 0.55,
      false,
      tongue.alpha * 0.7
    );
  }
}

function tongueGeometry(
  rear: Vec2,
  radius: number,
  tongue: HearthTongue,
  now: number
): ReturnType<typeof thrusterFlameGeometry> {
  const halfWidth = radius * tongue.halfWidth;
  const geomRadius = halfWidth / THRUSTER_HALF_WIDTH_RATIO;
  const flicker = Math.floor(now / VISUAL.THRUSTER_FLICKER_MS + tongue.phase) % 2 === 0;
  const snap = flicker ? 1 : 0.74;
  const roar = 0.9 + Math.sin(now / 150 + tongue.phase) * 0.1;
  const length = radius * tongue.lengthScale * snap * roar;
  return thrusterFlameGeometry(
    rear.x,
    rear.y,
    tongue.angle,
    geomRadius,
    length / geomRadius,
    VISUAL.THRUSTER_CORE_RATIO,
    rear
  );
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
