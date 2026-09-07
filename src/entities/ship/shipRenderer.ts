import type { SoftFactionId } from '../../../shared-types';
import { GAME, LASER, PALETTE, SHIELD, SHIP, TITLE, VISUAL } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import {
  driftSegment,
  easeOutCubic,
  laserBoltOffsets,
  strokeBurstTicks,
  strokePhosphorPolyline as strokeJuicePolyline,
  thrusterFlameGeometry,
} from '../../rendering/vectorJuice';
import { hexToRgba } from '../../utils/colorUtils';
import { isDebugMode } from '../../utils/debugUtils';
import { logger } from '../../utils/Logger';
import { drawSoftFactionMark } from '../player/factionMarkPainters';
import { findHarpoonFieldBody, getHarpoonField } from './harpoonField';
import {
  getKitHullOutline,
  projectHullPoint,
  projectHullPolyline,
  projectKitHullEdges,
} from './hullOutlines';
import type { Ship } from './Ship';
import { findHarpoonTarget } from './shipAbilities';
import {
  CLASSIC_HULL,
  HAULER_TETHER_COLOR,
  HAULER_TETHER_TIP_COLOR,
  type HullProfile,
  type ShipKitId,
} from './shipKits';
import { isShieldBlockingLasers, shieldCooldownFrames } from './shipShield';

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
  ctx: CanvasRenderingContext2D,
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
  ctx.shadowBlur = VISUAL.SHIP_GLOW;
  ctx.strokeStyle = hexToRgba(color, 0.4);
  trace();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  trace();
  ctx.stroke();
  ctx.restore();
}

export function strokePhosphorHull(
  ctx: CanvasRenderingContext2D,
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
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  color: string,
  kitId?: ShipKitId
): void {
  const outline = getKitHullOutline(kitId);
  strokePhosphorPolyline(
    ctx,
    projectHullPolyline(centerX, centerY, radius, angle, outline.hull),
    color,
    outline.hull.closed
  );
  for (const extra of outline.extras) {
    strokePhosphorPolyline(
      ctx,
      projectHullPolyline(centerX, centerY, radius, angle, extra),
      color,
      extra.closed
    );
  }
}

export function strokePhosphorSegment(
  ctx: CanvasRenderingContext2D,
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
  ctx.shadowBlur = glow;
  ctx.strokeStyle = hexToRgba(color, 0.5 * alpha);
  trace();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hexToRgba(color, alpha);
  trace();
  ctx.stroke();
  ctx.restore();
}

// Helper function to draw a targeting line extending from the ship
export function drawTargetingLine(
  centerX: number,
  centerY: number,
  angle: number,
  shipRadius: number,
  lineLength: number = 300,
  color: string = PALETTE.HUD,
  alpha: number = 0.6
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  // Calculate end point of the targeting line
  const endX = centerX + Math.cos(angle) * (shipRadius + lineLength);
  const endY = centerY - Math.sin(angle) * (shipRadius + lineLength);

  // Set line style with transparency
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]); // Dashed line for better visibility

  // Draw the targeting line
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  // Reset line style
  ctx.setLineDash([]);
  ctx.globalAlpha = 1.0;
}

export function drawGenericThruster(
  x: number,
  y: number,
  angle: number,
  radius: number,
  color: string = PALETTE.LOCAL,
  kitId?: ShipKitId
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const aft = getKitHullOutline(kitId).thruster;
  const rear = projectHullPoint(x, y, radius, angle, aft);
  const rearCenter = thrusterGeom.rearCenter;
  rearCenter.x = rear.x;
  rearCenter.y = rear.y;
  const flicker = Math.floor(performance.now() / VISUAL.THRUSTER_FLICKER_MS) % 2 === 0;
  const lengthRatio = flicker ? VISUAL.THRUSTER_LENGTH_RATIO : VISUAL.THRUSTER_FLICKER_RATIO;
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

export function drawThruster(ship: Ship, color: string = ship.color): void {
  const cvs = canvasManager.getCanvas();
  if (!cvs) {
    return;
  }

  if (!ship.exploding && ship.thrusting) {
    drawGenericThruster(cvs.width / 2, cvs.height / 2, ship.angle, ship.r, color, ship.kitId);
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
    const cull = ship.r * 3 * scale;
    if (
      screen.x < -cull ||
      screen.y < -cull ||
      screen.x > cvs.width + cull ||
      screen.y > cvs.height + cull
    ) {
      return;
    }
    drawGenericThruster(screen.x, screen.y, ship.angle, ship.r * scale, color, ship.kitId);
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
  ctx: CanvasRenderingContext2D,
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
  ctx.shadowBlur = VISUAL.EXPLOSION_STROKE_WIDTH + 1;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.55 + pop * VISUAL.EXPLOSION_RING_RATIO), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.shadowColor = color;
  ctx.shadowBlur = VISUAL.EXPLOSION_STROKE_WIDTH;
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

  drawVectorExplosion(
    ctx,
    cvs.width / 2,
    cvs.height / 2,
    ship.r * canvasManager.getPlayfieldScale(),
    ship.angle,
    explosionProgress(ship),
    color || ship.color || PALETTE.LOCAL,
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
    color || ship.color || PALETTE.REMOTE,
    ship.kitId
  );
}

export function drawLasers(
  ship: Ship,
  color?: string,
  viewerShipPosition?: { x: number; y: number }
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const boltColor = color || PALETTE.LASER_LOCAL;
  const cvs = canvasManager.getCanvas();
  const viewW = cvs?.width ?? Number.POSITIVE_INFINITY;
  const viewH = cvs?.height ?? Number.POSITIVE_INFINITY;
  const cullPad =
    (VISUAL.LASER_LENGTH + VISUAL.LASER_EXPLODE_RADIUS) * canvasManager.getPlayfieldScale();

  for (const laser of ship.lasers) {
    const referencePos = viewerShipPosition || ship.position;
    const screenPos = canvasManager.worldToScreenInto(laserScreen, laser.position, referencePos);
    if (
      screenPos.x < -cullPad ||
      screenPos.y < -cullPad ||
      screenPos.x > viewW + cullPad ||
      screenPos.y > viewH + cullPad
    ) {
      continue;
    }

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
      ctx.shadowBlur = VISUAL.LASER_GLOW;
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

export function drawEmpPulse(ship: Ship, empRadius: number, empAlpha: number): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();
  if (!ctx || !cvs) {
    return;
  }

  const centerX = cvs.width / 2;
  const centerY = cvs.height / 2;

  // Create a radial gradient for the EMP effect
  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, empRadius);

  // Electric blue to transparent effect
  gradient.addColorStop(0, `rgba(0, 255, 255, ${empAlpha * 0.8})`); // Cyan center
  gradient.addColorStop(0.3, `rgba(0, 150, 255, ${empAlpha * 0.6})`); // Blue
  gradient.addColorStop(0.7, `rgba(0, 100, 255, ${empAlpha * 0.4})`); // Darker blue
  gradient.addColorStop(1, `rgba(0, 50, 255, ${empAlpha * 0.1})`); // Very faint blue

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(centerX, centerY, empRadius, 0, Math.PI * 2, false);
  ctx.fill();

  // Add electric arc effects
  ctx.strokeStyle = `rgba(0, 255, 255, ${empAlpha})`;
  ctx.lineWidth = 2;

  // Draw some random electric arcs
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8;
    const startX = centerX + Math.cos(angle) * ship.r;
    const startY = centerY + Math.sin(angle) * ship.r;
    const endX = centerX + Math.cos(angle) * empRadius;
    const endY = centerY + Math.sin(angle) * empRadius;

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }
}

// Ship rendering with world coordinates (for other players)
export function drawShipAtPosition(
  ship: Ship,
  shipPosition: { x: number; y: number },
  color?: string,
  playerName?: string,
  factionId?: SoftFactionId
): void {
  const ctx = canvasManager.getContext();
  const cvs = canvasManager.getCanvas();

  if (!ctx || !cvs || ship.exploding || ship.health <= 0) {
    return;
  }

  const screen = canvasManager.worldToScreenInto(shipScreen, ship.position, shipPosition);
  const scale = canvasManager.getPlayfieldScale();
  const screenX = screen.x;
  const screenY = screen.y;
  const shipR = ship.r * scale;
  // Cable first — a barely-off-screen hull must not hide the cream tether.
  drawHaulerHarpoonVfx(ctx, ship, screenX, screenY, shipPosition);
  const cull = shipR * 3;
  if (
    screenX < -cull ||
    screenY < -cull ||
    screenX > cvs.width + cull ||
    screenY > cvs.height + cull
  ) {
    return;
  }

  if (ship.blinkCount > 0 && !ship.blinkOn) {
    return;
  }

  const shipColor = color || ship.color;

  strokeKitHullOutline(ctx, screenX, screenY, shipR, ship.angle, shipColor, ship.kitId);
  drawSoftFactionMark(ctx, factionId, {
    x: screenX,
    y: screenY,
    radius: shipR,
    angle: ship.angle,
  });
  drawAbilityFx(ctx, ship, screenX, screenY, shipR, shipPosition);

  drawShipShield(ctx, ship, screenX, screenY, shipR);
  drawShipImpactFlash(ctx, ship, screenX, screenY, shipR);
  drawFloatingHealthCapsule(ctx, ship, screenX, screenY, shipR);

  // Draw player name under ship if provided
  if (playerName) {
    drawPlayerName(playerName, screenX, screenY, shipR, shipColor);
  }
}

export function canDrawHaulerHarpoon(ship: {
  kitId: string;
  harpoonTimer: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: { x: number; y: number };
}): boolean {
  return (
    ship.kitId === 'hauler' &&
    ship.harpoonTimer > 0 &&
    (Boolean(ship.harpoonTargetId) || Boolean(ship.harpoonLatchPos))
  );
}

/** Generic E ring. Hauler must never show this — that is the live "activation-only" miss. */
export function canDrawGenericAbilityRing(ship: {
  kitId: string;
  abilityActiveFrames: number;
  harpoonTimer: number;
  shieldTimer: number;
}): boolean {
  return (
    ship.kitId !== 'hauler' &&
    ship.abilityActiveFrames > 0 &&
    ship.harpoonTimer <= 0 &&
    ship.shieldTimer <= 0
  );
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

/** Tether + amber tip. Hauler only — other kits never draw this. */
export function drawHaulerHarpoonVfx(
  ctx: CanvasRenderingContext2D,
  ship: Ship,
  screenX: number,
  screenY: number,
  cameraShipPosition: { x: number; y: number }
): void {
  if (ship.kitId !== 'hauler' || ship.harpoonTimer <= 0) {
    return;
  }
  const target = findHarpoonFieldBody(ship.harpoonTargetId);
  let latchWorld = target?.position ?? ship.harpoonLatchPos;
  if (!latchWorld) {
    latchWorld = findHarpoonTarget(
      ship,
      [...getHarpoonField()],
      Number.POSITIVE_INFINITY
    )?.position;
  }
  if (!latchWorld) {
    return;
  }
  if (target) {
    ship.harpoonLatchPos = { x: target.position.x, y: target.position.y };
  } else if (!ship.harpoonLatchPos) {
    ship.harpoonLatchPos = { x: latchWorld.x, y: latchWorld.y };
  }

  const latch = canvasManager.worldToScreen(latchWorld, cameraShipPosition);
  const style = harpoonTetherStyle();
  ctx.save();
  ctx.strokeStyle = HAULER_TETHER_COLOR;
  ctx.shadowColor = HAULER_TETHER_COLOR;
  ctx.shadowBlur = 2.5;
  ctx.lineWidth = style.lineWidth;
  ctx.setLineDash(style.dash);
  ctx.beginPath();
  ctx.moveTo(screenX, screenY);
  ctx.lineTo(latch.x, latch.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = HAULER_TETHER_TIP_COLOR;
  ctx.beginPath();
  ctx.arc(latch.x, latch.y, style.tipRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Ability rings only. Kit hulls come from the v2 outline bake. */
function drawAbilityFx(
  ctx: CanvasRenderingContext2D,
  ship: Ship,
  screenX: number,
  screenY: number,
  shipR: number,
  _cameraShipPosition: { x: number; y: number }
): void {
  if (ship.shieldTimer > 0) {
    const pulse = 0.45 + 0.25 * Math.sin(Date.now() / 90);
    ctx.beginPath();
    ctx.arc(screenX, screenY, shipR + 10, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(PALETTE.HUD, pulse);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (canDrawGenericAbilityRing(ship)) {
    ctx.beginPath();
    ctx.arc(screenX, screenY, shipR + 6, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(TITLE.ACCENT, 0.45);
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

export function drawShipShield(
  ctx: CanvasRenderingContext2D,
  ship: Ship,
  screenX: number,
  screenY: number,
  shipR: number
): void {
  if (ship.exploding) {
    return;
  }

  const radius = shipR * SHIELD.RADIUS_RATIO;

  if (isShieldBlockingLasers(ship)) {
    const flashing = ship.shieldFlashTime > 0;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = flashing ? VISUAL.SHIELD_STROKE_WIDTH + 0.5 : VISUAL.SHIELD_STROKE_WIDTH;
    ctx.shadowColor = PALETTE.SHIELD;
    ctx.shadowBlur = VISUAL.SHIELD_GLOW;
    ctx.strokeStyle = hexToRgba(PALETTE.SHIELD, flashing ? 1 : 0.9);
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (ship.isLocalPlayer && ship.shieldCooldown > 0) {
    const remaining = ship.shieldCooldown / shieldCooldownFrames();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexToRgba(PALETTE.HUD_MUTED, 0.35);
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, -Math.PI / 2, -Math.PI / 2 + remaining * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawShipImpactFlash(
  ctx: CanvasRenderingContext2D,
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
  ctx.shadowBlur = VISUAL.SHIP_GLOW + 1;
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
  ctx: CanvasRenderingContext2D,
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

// Helper function to draw player health bar in the HUD
export function drawPlayerHealthBar(health: number, maxHealth: number): void {
  const ctx = canvasManager.getContext();
  const canvas = canvasManager.getCanvas();
  if (!ctx || !canvas) {
    return;
  }

  // Debug logging for health bar values
  if (health !== maxHealth) {
    logger.debug('HEALTH_BAR', 'Drawing health bar with non-full health', {
      health,
      maxHealth,
      healthPercent: health / maxHealth,
    });
  }

  const barWidth = 200;
  const barHeight = 20;
  const barX = canvas.width - barWidth - 20;
  const barY = 20;

  // Health percentage
  const healthPercent = health / maxHealth;
  const currentWidth = barWidth * healthPercent;

  ctx.save();

  // Background (empty health bar)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(barX, barY, barWidth, barHeight);

  // Health bar color based on health level
  let healthColor: string;
  if (healthPercent > 0.6) {
    healthColor = PALETTE.HEALTH;
  } else if (healthPercent > 0.3) {
    healthColor = PALETTE.LASER_LOCAL;
  } else {
    healthColor = PALETTE.DANGER;
  }

  // Current health
  ctx.fillStyle = healthColor;
  ctx.fillRect(barX, barY, currentWidth, barHeight);

  // Border
  ctx.strokeStyle = PALETTE.HUD;
  ctx.lineWidth = 2;
  ctx.strokeRect(barX, barY, barWidth, barHeight);

  // Health text
  ctx.fillStyle = PALETTE.HUD;
  ctx.font = '14px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.ceil(health)}/${maxHealth}`, barX + barWidth / 2, barY - 8);

  ctx.restore();
}
