import type { HaulerUtilityId, Position, ShipKitId, Velocity } from '../../../shared-types';
import { GAME, LASER, PALETTE, SHIP, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvasSurface';
import type { DrawingContext } from '../../rendering/drawingContext';
import type { PlayfieldSize } from '../../rendering/playfieldCamera';
import { resolveGlow } from '../../rendering/renderQuality';
import {
  driftSegment,
  easeOutCubic,
  laserBoltOffsets,
  strokeBurstTicks,
  strokePhosphorPolyline as strokeJuicePolyline,
  thrusterFlameGeometry,
} from '../../rendering/vectorJuice';
import { hexToRgba, laserBoltColor } from '../../utils/colorUtils';
import { isDebugMode } from '../../utils/debugUtils';
import { findHarpoonFieldBody } from './harpoonField';
import { haulerUtilityOf, isResourceTapUtility } from './haulerUtility';
import {
  getHaulerEquipment,
  getKitHullOutline,
  projectHullPoint,
  projectHullPolyline,
  projectKitHullEdges,
} from './hullOutlines';
import type { Ship } from './Ship';
import { CLASSIC_HULL, type HullProfile, SHIP_ABILITY } from './shipKits';

const shipTriangle = {
  nose: { x: 0, y: 0 },
  rearLeft: { x: 0, y: 0 },
  rearRight: { x: 0, y: 0 },
};

const thrusterGeom = {
  rearCenter: { x: 0, y: 0 },
};

const laserScreen = { x: 0, y: 0 };
const shipScreen = { x: 0, y: 0 };
// Helper function to calculate ship triangle points for consistent ship rendering
export function calculateShipTrianglePoints(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  hull: HullProfile = CLASSIC_HULL
): {
  nose: { x: number; y: number };
  rearLeft: { x: number; y: number };
  rearRight: { x: number; y: number };
} {
  shipTriangle.nose.x = centerX + radius * hull.nose * Math.cos(angle);
  shipTriangle.nose.y = centerY - radius * hull.nose * Math.sin(angle);
  shipTriangle.rearLeft.x =
    centerX - radius * hull.rear * Math.cos(angle) + radius * hull.beam * Math.sin(angle);
  shipTriangle.rearLeft.y =
    centerY + radius * hull.rear * Math.sin(angle) + radius * hull.beam * Math.cos(angle);
  shipTriangle.rearRight.x =
    centerX - radius * hull.rear * Math.cos(angle) - radius * hull.beam * Math.sin(angle);
  shipTriangle.rearRight.y =
    centerY + radius * hull.rear * Math.sin(angle) - radius * hull.beam * Math.cos(angle);
  return shipTriangle;
}

/** Shared phosphor stroke for v2 kit outlines (and the leftover 3-point helper). */
export function strokePhosphorPolyline(
  ctx: DrawingContext,
  points: readonly { x: number; y: number }[],
  color: string,
  closed = true
): void {
  const first = points[0];
  if (!first) {
    return;
  }

  const trace = (): void => {
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
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = VISUAL.SHIP_STROKE_WIDTH;
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(VISUAL.SHIP_GLOW);
  ctx.strokeStyle = hexToRgba(color, 0.4);
  trace();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  // stroke() retains the path; reuse it for the crisp pass.
  ctx.stroke();
  ctx.restore();
}

export function strokePhosphorHull(
  ctx: DrawingContext,
  hull: {
    nose: { x: number; y: number };
    rearLeft: { x: number; y: number };
    rearRight: { x: number; y: number };
  },
  color: string
): void {
  strokePhosphorPolyline(ctx, [hull.nose, hull.rearLeft, hull.rearRight], color, true);
}

export function strokeKitHullOutline(
  ctx: DrawingContext,
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  color: string,
  kitId?: ShipKitId,
  utility: HaulerUtilityId = 'tow_cable'
): void {
  const outline = getKitHullOutline(kitId);
  strokePhosphorPolyline(
    ctx,
    projectHullPolyline(centerX, centerY, radius, angle, outline.hull),
    color,
    outline.hull.closed
  );
  const details =
    outline.kitId === 'hauler'
      ? [...outline.extras, ...getHaulerEquipment(utility)]
      : outline.extras;
  for (const extra of details) {
    strokePhosphorPolyline(
      ctx,
      projectHullPolyline(centerX, centerY, radius, angle, extra),
      color,
      extra.closed
    );
  }
}

export function strokePhosphorSegment(
  ctx: DrawingContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  glow: number,
  alpha = 1
): void {
  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(glow);
  ctx.strokeStyle = hexToRgba(color, 0.5 * alpha);
  trace();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexToRgba(color, alpha);
  trace();
  ctx.stroke();
  ctx.restore();
}

export function drawGenericThruster(
  x: number,
  y: number,
  angle: number,
  radius: number,
  color: string = PALETTE.LOCAL,
  kitId?: ShipKitId,
  boosting = false
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const outline = getKitHullOutline(kitId);
  const flicker = Math.floor(performance.now() / VISUAL.THRUSTER_FLICKER_MS) % 2 === 0;
  const lengthRatio =
    (flicker ? VISUAL.THRUSTER_LENGTH_RATIO : VISUAL.THRUSTER_FLICKER_RATIO) *
    (boosting ? 1.45 : 1);
  const rearCenter = thrusterGeom.rearCenter;
  for (const aft of outline.nozzles) {
    const rear = projectHullPoint(x, y, radius, angle, aft);
    rearCenter.x = rear.x;
    rearCenter.y = rear.y;
    const flame = thrusterFlameGeometry(
      x,
      y,
      angle,
      radius,
      lengthRatio,
      VISUAL.THRUSTER_CORE_RATIO,
      rearCenter
    );

    strokeJuicePolyline(
      ctx,
      [flame.left, flame.tip, flame.right],
      color,
      VISUAL.THRUSTER_STROKE_WIDTH,
      VISUAL.THRUSTER_GLOW,
      false
    );
    strokeJuicePolyline(
      ctx,
      [flame.coreLeft, flame.coreTip, flame.coreRight],
      color,
      VISUAL.THRUSTER_STROKE_WIDTH * 0.75,
      VISUAL.THRUSTER_GLOW * 0.55,
      false,
      0.7
    );
  }
}

export function drawThruster(ship: Ship, color: string = ship.color): void {
  const cvs = canvasManager.getCanvas();
  if (!cvs) {
    return;
  }

  if (!ship.exploding && ship.thrusting) {
    const viewport = canvasManager.getViewportSize();
    drawGenericThruster(
      viewport.width / 2,
      viewport.height / 2,
      ship.angle,
      ship.r,
      color,
      ship.kitId,
      ship.boosting
    );
  }
}

export function drawThrusterAtPosition(
  ship: Ship,
  shipPosition: { x: number; y: number },
  color: string = ship.color
): void {
  const cvs = canvasManager.getCanvas();
  if (!cvs) {
    return;
  }

  if (!ship.exploding && ship.thrusting) {
    const screen = canvasManager.worldToScreenInto(shipScreen, ship.position, shipPosition);
    const scale = canvasManager.getPlayfieldScale();
    const viewport = canvasManager.getViewportSize();
    const cull = ship.r * 3 * scale;
    if (
      screen.x < -cull ||
      screen.y < -cull ||
      screen.x > viewport.width + cull ||
      screen.y > viewport.height + cull
    ) {
      return;
    }
    drawGenericThruster(
      screen.x,
      screen.y,
      ship.angle,
      ship.r * scale,
      color,
      ship.kitId,
      ship.boosting
    );
  }
}

// Helper function to draw player name under ship
export function drawPlayerName(
  name: string,
  x: number,
  y: number,
  shipRadius: number,
  color: string = PALETTE.HUD
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const nameY = y + shipRadius + 14;

  ctx.save();
  ctx.fillStyle = hexToRgba(color, VISUAL.NAME_LABEL_ALPHA);
  ctx.font = VISUAL.NAME_LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(name, x, nameY);
  ctx.restore();
}

// Vector break-up: hull edges pop, then drift; ring + ticks — no filled fireball.
function drawVectorExplosion(
  ctx: DrawingContext,
  x: number,
  y: number,
  radius: number,
  angle: number,
  progress: number,
  color: string,
  kitId?: ShipKitId
): void {
  const t = clampExplosion(progress);
  const pop = easeOutCubic(t);
  const alpha = 1 - t * 0.85;
  const spread = radius * VISUAL.EXPLOSION_SPREAD_RATIO;
  const origin = { x, y };
  const edges = projectKitHullEdges(x, y, radius, angle, kitId);

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, alpha * 0.85);
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(VISUAL.EXPLOSION_STROKE_WIDTH + 1);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.55 + pop * VISUAL.EXPLOSION_RING_RATIO), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.shadowColor = color;
  ctx.shadowBlur = resolveGlow(VISUAL.EXPLOSION_STROKE_WIDTH);
  ctx.lineWidth = VISUAL.EXPLOSION_STROKE_WIDTH;
  ctx.lineCap = 'round';

  for (const [a, b] of edges) {
    const edge = driftSegment(a, b, origin, t, spread, 0.7);
    ctx.beginPath();
    ctx.moveTo(edge.a.x, edge.a.y);
    ctx.lineTo(edge.b.x, edge.b.y);
    ctx.stroke();
  }
  ctx.restore();

  const sparkInner = radius * (0.35 + pop * 1.15);
  const sparkOuter = sparkInner + radius * (0.35 + (1 - t) * 0.2);
  strokeBurstTicks(
    ctx,
    x,
    y,
    VISUAL.EXPLOSION_SPARKS,
    angle + 0.35,
    sparkInner,
    sparkOuter,
    color,
    alpha,
    1,
    VISUAL.EXPLOSION_STROKE_WIDTH
  );
  strokeBurstTicks(
    ctx,
    x,
    y,
    VISUAL.EXPLOSION_HIT_TICKS,
    angle,
    radius * (0.2 + pop * 0.4),
    radius * (1.1 + pop * 1.1),
    color,
    alpha * 0.75,
    1,
    VISUAL.EXPLOSION_STROKE_WIDTH
  );
}

function clampExplosion(progress: number): number {
  return Math.min(Math.max(progress, 0), 1);
}

function explosionProgress(ship: Ship): number {
  return 1 - ship.explodeTime / SHIP.EXPLODE_DURATION_FRAMES;
}

export function drawShipExplosion(ship: Ship, color?: string): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const viewport = canvasManager.getViewportSize();
  drawVectorExplosion(
    ctx,
    viewport.width / 2,
    viewport.height / 2,
    ship.r * canvasManager.getPlayfieldScale(),
    ship.angle,
    explosionProgress(ship),
    color ?? ship.color ?? PALETTE.LOCAL,
    ship.kitId
  );
}

export function drawShipExplosionAtPosition(
  ship: Ship,
  shipPosition: { x: number; y: number },
  color?: string
): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const screen = canvasManager.worldToScreenInto(shipScreen, ship.position, shipPosition);
  const scale = canvasManager.getPlayfieldScale();
  drawVectorExplosion(
    ctx,
    screen.x,
    screen.y,
    ship.r * scale,
    ship.angle,
    explosionProgress(ship),
    color ?? ship.color ?? PALETTE.REMOTE,
    ship.kitId
  );
}

export function drawLaserBolts(
  lasers: Array<{
    position: Position;
    velocity: Velocity;
    explodeTime: number;
    bounceCount?: number;
  }>,
  color: string,
  viewerPosition: Position
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const cvs = canvasManager.getCanvas();
  const viewport = cvs ? canvasManager.getViewportSize() : undefined;
  const viewW = viewport?.width ?? Number.POSITIVE_INFINITY;
  const viewH = viewport?.height ?? Number.POSITIVE_INFINITY;
  const cullPad =
    (VISUAL.LASER_LENGTH + VISUAL.LASER_EXPLODE_RADIUS) * canvasManager.getPlayfieldScale();

  for (const laser of lasers) {
    const screenPos = canvasManager.worldToScreenInto(laserScreen, laser.position, viewerPosition);
    if (
      screenPos.x < -cullPad ||
      screenPos.y < -cullPad ||
      screenPos.x > viewW + cullPad ||
      screenPos.y > viewH + cullPad
    ) {
      continue;
    }

    const boltColor = laserBoltColor(color, laser.bounceCount);
    if (laser.explodeTime === 0) {
      const scale = canvasManager.getPlayfieldScale();
      const bolt = (VISUAL.LASER_LENGTH / 2) * scale;
      const { halfX, halfY, trailX, trailY } = laserBoltOffsets(
        laser.velocity.x,
        laser.velocity.y,
        bolt,
        VISUAL.LASER_TRAIL_LENGTH * scale
      );
      strokePhosphorSegment(
        ctx,
        screenPos.x - halfX - trailX,
        screenPos.y - halfY - trailY,
        screenPos.x - halfX,
        screenPos.y - halfY,
        boltColor,
        VISUAL.LASER_STROKE_WIDTH * 0.7,
        VISUAL.LASER_GLOW * 0.55,
        0.38
      );
      strokePhosphorSegment(
        ctx,
        screenPos.x - halfX,
        screenPos.y - halfY,
        screenPos.x + halfX,
        screenPos.y + halfY,
        boltColor,
        VISUAL.LASER_STROKE_WIDTH,
        VISUAL.LASER_GLOW
      );
    } else {
      const t = 1 - laser.explodeTime / Math.ceil(LASER.EXPLODE_DURATION * GAME.FPS);
      const ringRadius = VISUAL.LASER_EXPLODE_RADIUS * (0.55 + t * 1.15);
      const alpha = 1 - t * 0.7;
      ctx.save();
      ctx.shadowColor = boltColor;
      ctx.shadowBlur = resolveGlow(VISUAL.LASER_GLOW);
      ctx.strokeStyle = hexToRgba(boltColor, alpha);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, ringRadius, 0, Math.PI * 2, false);
      ctx.stroke();
      ctx.restore();
      strokeBurstTicks(
        ctx,
        screenPos.x,
        screenPos.y,
        VISUAL.LASER_HIT_TICKS,
        t * 0.5,
        ringRadius * 0.35,
        ringRadius * 1.35,
        boltColor,
        alpha,
        1,
        VISUAL.LASER_GLOW
      );
    }
  }
}

export function drawLasers(
  ship: Ship,
  color?: string,
  viewerShipPosition?: { x: number; y: number }
): void {
  drawLaserBolts(ship.lasers, color ?? PALETTE.LASER_LOCAL, viewerShipPosition ?? ship.position);
}

// Ship rendering with world coordinates (for other players)
export function drawShipAtPosition(
  ship: Ship,
  shipPosition: { x: number; y: number },
  color?: string,
  playerName?: string
): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();

  if (!ctx || !cvs || ship.exploding || ship.health <= 0) {
    return;
  }

  const screen = canvasManager.worldToScreenInto(shipScreen, ship.position, shipPosition);
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const screenX = screen.x;
  const screenY = screen.y;
  const shipR = ship.r * scale;
  const cull = shipR * 3;
  if (
    screenX < -cull ||
    screenY < -cull ||
    screenX > viewport.width + cull ||
    screenY > viewport.height + cull
  ) {
    return;
  }

  if (ship.blinkCount > 0 && !ship.blinkOn) {
    return;
  }

  const shipColor = color ?? ship.color;

  strokeKitHullOutline(
    ctx,
    screenX,
    screenY,
    shipR,
    ship.angle,
    shipColor,
    ship.kitId,
    haulerUtilityOf(ship)
  );
  drawAbilityFx(ctx, ship, screenX, screenY, shipR);

  drawShipImpactFlash(ctx, ship, screenX, screenY, shipR);
  drawFloatingHealthCapsule(ctx, ship, screenX, screenY, shipR);

  // Draw player name under ship if provided
  if (playerName) {
    drawPlayerName(playerName, screenX, screenY, shipR, shipColor);
  }
}

export function canDrawHaulerHarpoon(ship: {
  kitId: string;
  harpoonTargetId: string | null;
}): boolean {
  return ship.kitId === 'hauler' && ship.harpoonTargetId !== null;
}

/** Tether geometry is already in screen space; keep it hairline at every zoom. */
export function harpoonTetherStyle(): { dash: number[]; lineWidth: number; tipRadius: number } {
  return {
    // Solid cream — dashes ate the GD lock pixels on zoomed 1:1 samples.
    dash: [],
    lineWidth: 1.5,
    tipRadius: 3.5,
  };
}

/** World-space cable. Drawn even when the hull is exploding or culled. */
export function drawHaulerHarpoonRelative(
  ship: Ship,
  cameraShipPosition: { x: number; y: number }
): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }
  const screen = canvasManager.worldToScreenInto(shipScreen, ship.position, cameraShipPosition);
  drawHaulerHarpoonVfx(ctx, ship, screen.x, screen.y, cameraShipPosition);
}

/** Tether + amber tip. Hauler only — other kits never draw this. */
export function drawHaulerHarpoonVfx(
  ctx: DrawingContext,
  ship: Ship,
  screenX: number,
  screenY: number,
  cameraShipPosition: { x: number; y: number }
): void {
  if (ship.kitId !== 'hauler' || ship.harpoonTargetId === null) {
    return;
  }
  const target = findHarpoonFieldBody(ship.harpoonTargetId);
  const latchWorld = target?.position ?? ship.harpoonLatchPos;
  if (!latchWorld) {
    return;
  }
  if (target) {
    ship.harpoonLatchPos = { x: target.position.x, y: target.position.y };
  } else {
    ship.harpoonLatchPos ??= { x: latchWorld.x, y: latchWorld.y };
  }

  const latch = canvasManager.worldToScreen(latchWorld, cameraShipPosition);
  const style = harpoonTetherStyle();
  ctx.save();
  // Literals stay in this module. Imported HAULER_TETHER_* hexes were
  // Rolldown-renamed across the asteroidPhenomena split: cream became
  // strokeStyle=_e (no binding) and tip became fillStyle=t (the ship param).
  ctx.strokeStyle = '#E8D5A3';
  ctx.lineWidth = style.lineWidth;
  ctx.setLineDash(style.dash);
  ctx.beginPath();
  ctx.moveTo(screenX, screenY);
  ctx.lineTo(latch.x, latch.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#FDE68A';
  ctx.strokeStyle = '#FDE68A';
  ctx.beginPath();
  ctx.arc(latch.x, latch.y, style.tipRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (isResourceTapUtility(ship)) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const cycle = (now / 1000) % 1;
    for (let i = 0; i < 5; i++) {
      const u = (cycle + i / 5) % 1;
      const x = latch.x + (screenX - latch.x) * u;
      const y = latch.y + (screenY - latch.y) * u;
      ctx.fillStyle = i === 4 ? '#FDE68A' : '#E8D5A3';
      ctx.beginPath();
      ctx.arc(x, y, 1.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

const SURVEYOR_SCAN_PULSE_COUNT = 3;
const SURVEYOR_SCAN_PULSE_FRAMES = SHIP_ABILITY.SCAN_FRAMES / SURVEYOR_SCAN_PULSE_COUNT;
const SURVEYOR_SCAN_EDGE_OVERSHOOT = 1.1;
const SURVEYOR_SCAN_FADE_START = 0.75;
const SURVEYOR_SCAN_MAX_ALPHA = 0.28;

export interface SurveyorScanVisualHost {
  kitId: Ship['kitId'];
  abilityActiveFrames: number;
  health: number;
  exploding: boolean;
}

interface SurveyorScanPulse {
  readonly radius: number;
  readonly alpha: number;
}

/** One of three expanding radar pulses, measured in viewport pixels. */
export function surveyorScanPulseGeometry(
  pulseIndex: number,
  screenX: number,
  screenY: number,
  shipR: number,
  abilityActiveFrames: number,
  viewport: Readonly<PlayfieldSize>
): SurveyorScanPulse | undefined {
  if (
    !Number.isInteger(pulseIndex) ||
    pulseIndex < 0 ||
    pulseIndex >= SURVEYOR_SCAN_PULSE_COUNT ||
    !Number.isFinite(abilityActiveFrames) ||
    abilityActiveFrames <= 0
  ) {
    return undefined;
  }

  const elapsedFrames = Math.min(
    SHIP_ABILITY.SCAN_FRAMES,
    Math.max(0, SHIP_ABILITY.SCAN_FRAMES - abilityActiveFrames)
  );
  const pulseElapsed = elapsedFrames - pulseIndex * SURVEYOR_SCAN_PULSE_FRAMES;
  if (pulseElapsed < 0 || pulseElapsed >= SURVEYOR_SCAN_PULSE_FRAMES) {
    return undefined;
  }

  const farthestCornerX = Math.max(screenX, viewport.width - screenX);
  const farthestCornerY = Math.max(screenY, viewport.height - screenY);
  const edgeRadius = Math.max(
    shipR,
    Math.hypot(farthestCornerX, farthestCornerY) * SURVEYOR_SCAN_EDGE_OVERSHOOT
  );
  const progress = pulseElapsed / SURVEYOR_SCAN_PULSE_FRAMES;
  const fade =
    progress <= SURVEYOR_SCAN_FADE_START ? 1 : (1 - progress) / (1 - SURVEYOR_SCAN_FADE_START);
  return {
    radius: shipR + (edgeRadius - shipR) * progress,
    alpha: SURVEYOR_SCAN_MAX_ALPHA * fade,
  };
}

/** Draw the Surveyor radar sweep in viewport space; it never changes scan gameplay. */
export function drawSurveyorScanFx(
  ctx: DrawingContext,
  host: SurveyorScanVisualHost,
  screenX: number,
  screenY: number,
  shipR: number,
  viewport: Readonly<PlayfieldSize>
): void {
  if (
    host.kitId !== 'surveyor' ||
    host.exploding ||
    host.health <= 0 ||
    host.abilityActiveFrames <= 0
  ) {
    return;
  }

  for (let pulseIndex = 0; pulseIndex < SURVEYOR_SCAN_PULSE_COUNT; pulseIndex += 1) {
    const pulse = surveyorScanPulseGeometry(
      pulseIndex,
      screenX,
      screenY,
      shipR,
      host.abilityActiveFrames,
      viewport
    );
    if (!pulse) {
      continue;
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = VISUAL.SHIP_STROKE_WIDTH;
    ctx.shadowColor = PALETTE.LOCAL;
    ctx.shadowBlur = resolveGlow(VISUAL.SHIP_GLOW);
    ctx.strokeStyle = hexToRgba(PALETTE.LOCAL, pulse.alpha);
    ctx.beginPath();
    ctx.arc(screenX, screenY, pulse.radius, 0, Math.PI * 2, false);
    ctx.stroke();
    ctx.restore();
  }
}

/** Ability rings only. Kit hulls come from the v2 outline bake. */
function drawAbilityFx(
  ctx: DrawingContext,
  ship: Ship,
  screenX: number,
  screenY: number,
  shipR: number
): void {
  drawSurveyorScanFx(ctx, ship, screenX, screenY, shipR, canvasManager.getViewportSize());
}

function drawShipImpactFlash(
  ctx: DrawingContext,
  ship: Ship,
  screenX: number,
  screenY: number,
  shipR: number
): void {
  if (ship.impactFlashFrames <= 0) {
    return;
  }

  const t = 1 - ship.impactFlashFrames / SHIP.IMPACT_FLASH_FRAMES;
  const alpha = 1 - t * 0.7;
  const ring = shipR * (1.15 + t * 0.55);
  ctx.save();
  ctx.strokeStyle = hexToRgba(PALETTE.DANGER, alpha);
  ctx.lineWidth = 1.15;
  ctx.shadowColor = PALETTE.DANGER;
  ctx.shadowBlur = resolveGlow(VISUAL.SHIP_GLOW + 1);
  ctx.beginPath();
  ctx.arc(screenX, screenY, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  strokeBurstTicks(
    ctx,
    screenX,
    screenY,
    VISUAL.EXPLOSION_HIT_TICKS,
    t,
    shipR * 0.85,
    ring * 1.25,
    PALETTE.DANGER,
    alpha,
    1,
    VISUAL.SHIP_GLOW
  );
}

function drawFloatingHealthCapsule(
  ctx: DrawingContext,
  ship: Ship,
  screenX: number,
  screenY: number,
  shipR: number
): void {
  const damaged = ship.health < ship.maxHealth;
  if (!damaged && ship.impactFlashFrames <= 0 && !isDebugMode()) {
    return;
  }

  const barWidth = shipR * 2.4;
  const barY = screenY - shipR - 10;
  const barX = screenX - barWidth / 2;
  const healthPercent = Math.max(0, ship.health / ship.maxHealth);
  const currentWidth = barWidth * healthPercent;

  // Two hairline strokes: a muted track and the remaining-health segment on top.
  ctx.save();
  ctx.lineWidth = VISUAL.HEALTH_CAPSULE_HEIGHT;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.45);
  ctx.beginPath();
  ctx.moveTo(barX, barY);
  ctx.lineTo(barX + barWidth, barY);
  ctx.stroke();
  if (currentWidth > 0) {
    ctx.strokeStyle = PALETTE.HEALTH;
    ctx.beginPath();
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + currentWidth, barY);
    ctx.stroke();
  }

  if (isDebugMode()) {
    ctx.fillStyle = PALETTE.HUD;
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.ceil(ship.health)}/${ship.maxHealth}`, screenX, barY - 10);
  }
  ctx.restore();
}
