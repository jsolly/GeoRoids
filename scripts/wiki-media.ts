import './wiki-media-node-shim';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas } from 'canvas';
import { AsteroidManager } from '../server/core/AsteroidManager';
import { LootManager } from '../server/core/LootManager';
import { RNGService } from '../server/core/RNGService';
import { SatellitePickupManager } from '../server/core/SatellitePickupManager';
import {
  asteroidInertia,
  asteroidSurfaceLatch,
  coupleAsteroidMomentum,
  stepReleasedMotion,
  tangentVelocity,
} from '../shared/asteroidMotion';
import {
  ASTEROID_INTERACTIONS,
  previewChargedReflections,
  segmentCircleContact,
} from '../shared/asteroidPhenomena';
import { SATELLITE_PROFILES } from '../shared/eoSatellites';
import {
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
  LOOT_BLAST,
} from '../shared/lootBlast';
import {
  applyLootMass,
  lootOverlap,
  radiusFromMass,
  sizeScaleFromMass,
} from '../shared/shipGrowth';
import type { AsteroidData, Position, Velocity } from '../shared-types';
import { FUEL, GAME, PALETTE, SHIP, TITLE, VISUAL } from '../src/constants';
import { lootScreenRadius, lootStrokeColor } from '../src/entities/loot/lootRenderer';
import { drawAsteroidMaterialDetails } from '../src/entities/roid/materialArt';
import { drawRoidInteractionCues } from '../src/entities/roid/roidRenderer';
import { drawEoSatelliteOutline } from '../src/entities/satellite/eoOutlines';
import { laserVelocityFromAngle } from '../src/entities/satellite/satelliteMath';
import { drawSatellitePickupMiniMapDot } from '../src/entities/satellitePickup/satellitePickupRenderer';
import { getKitHullOutline, projectHullPoint } from '../src/entities/ship/hullOutlines';
import {
  type AbilityBody,
  type AbilityHost,
  type AbilityWorld,
  absorbDamageWithShield,
  activateAbilityOnHost,
  pullHarpoonTarget,
  tickAbilityHost,
} from '../src/entities/ship/shipAbilities';
import { getShipKit, SHIP_ABILITY, type ShipKitId } from '../src/entities/ship/shipKits';
import { strokeKitHullOutline, strokePhosphorSegment } from '../src/entities/ship/shipRenderer';
import {
  activateShield,
  createShieldState,
  isShieldBlockingLasers,
  updateShield,
} from '../src/entities/ship/shipShield';
import { applyThrustOrFriction, moveFrictionForShip } from '../src/entities/ship/shipUtils';
import { stepAsteroidMotion } from '../src/physics/asteroidMotion';
import { getGameBoundary } from '../src/physics/boundary';
import {
  applyShockwaveToBody,
  easedRingRadius,
  ringAlpha,
  SHOCKWAVE_WAVES,
  waveVisualProgress,
} from '../src/physics/shockwave';
import { extractIsoContours } from '../src/physics/terrain/contours';
import {
  createHeightfield,
  sampleGradient,
  sampleHeight,
} from '../src/physics/terrain/heightfield';
import { applySlopeForce } from '../src/physics/terrain/slopeForce';
import { drawContourLabels } from '../src/rendering/contourLabels';
import type { DrawingContext } from '../src/rendering/drawingContext';
import {
  polygonPoints,
  strokePhosphorPolyline,
  thrusterFlameGeometry,
} from '../src/rendering/vectorJuice';
import { media } from '../src/wiki/media';
import { recordSatelliteDemo, type SatelliteDemoPanel } from './wiki-satellite-demo';

type RenderContext = DrawingContext;
type MediaId =
  | 'dart'
  | 'hauler'
  | 'warden'
  | 'skirmisher'
  | 'quake'
  | 'movement'
  | 'terrain'
  | 'loot'
  | 'reflection'
  | 'shield'
  | 'split'
  | 'slingshot'
  | 'winch'
  | 'satellites'
  | 'pickups';

const MEDIA_IDS: readonly MediaId[] = [
  'dart',
  'hauler',
  'warden',
  'skirmisher',
  'quake',
  'movement',
  'terrain',
  'loot',
  'reflection',
  'shield',
  'split',
  'slingshot',
  'winch',
  'satellites',
  'pickups',
];

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 10;
const FRAME_COUNT = 48;
const SIM_TICKS_PER_FRAME = GAME.FPS / FPS;
const SEED = 0x4f9d3c21;
const ENCODER_VERSION = 'Pillow 12.3.0';
const ENCODER_SCRIPT = resolve('scripts/wiki-media-encode.py');
const STAR_SEED = 0x9e3779b9;

function renderHull(
  ctx: RenderContext,
  x: number,
  y: number,
  radius: number,
  angle: number,
  color: string,
  kitId: ShipKitId
): void {
  strokeKitHullOutline(ctx, x, y, radius, angle, color, kitId);
}

function renderSegment(
  ctx: RenderContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  glow: number
): void {
  strokePhosphorSegment(ctx, x1, y1, x2, y2, color, width, glow);
}

function renderPolyline(
  ctx: RenderContext,
  points: readonly Position[],
  color: string,
  width: number,
  glow: number,
  closed: boolean,
  alpha?: number
): void {
  strokePhosphorPolyline(ctx, points, color, width, glow, closed, alpha);
}

function renderMaterial(
  ctx: RenderContext,
  material: 'ice' | 'metal' | 'rubble',
  x: number,
  y: number,
  radius: number,
  rotation: number,
  healthFraction: number
): void {
  drawAsteroidMaterialDetails(ctx, material, x, y, radius, rotation, healthFraction);
}

function renderRoidCue(
  ctx: RenderContext,
  roid: Pick<AsteroidData, 'phenomenon' | 'spinClass'>,
  radius: number,
  x: number,
  y: number
): void {
  drawRoidInteractionCues(ctx, roid, radius, x, y);
}

function renderSatellite(
  ctx: RenderContext,
  typeId: Parameters<typeof drawEoSatelliteOutline>[1],
  radius: number,
  angle: number,
  color: string,
  firing: boolean
): void {
  drawEoSatelliteOutline(ctx, typeId, radius, angle, color, firing);
}

function renderPickupDot(ctx: RenderContext, x: number, y: number): void {
  drawSatellitePickupMiniMapDot(ctx, x, y);
}

interface Demo {
  id: MediaId;
  posterFrame: number;
  verify: () => void;
  render: (ctx: RenderContext, frame: number) => void;
}

interface RenderedRun {
  root: string;
  frameHashes: Partial<Record<MediaId, string[]>>;
}

interface AssetManifest {
  frameHashes: string[];
  gifSha256: string;
  posterSha256: string;
}

interface MediaManifest {
  version: 1;
  seed: number;
  simulationFps: number;
  ticksPerFrame: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  encoder: string;
  assets: Partial<Record<MediaId, AssetManifest>>;
}

function invariant(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`wiki-media verification failed: ${message}`);
  }
}

function runSimulationTicks(ticks: number, step: () => void): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    step();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function copyPosition(position: Position): Position {
  return { x: position.x, y: position.y };
}

function screenPoint(position: Position, scale = 1): Position {
  return {
    x: WIDTH / 2 + position.x * scale,
    y: HEIGHT / 2 + position.y * scale,
  };
}

function assertSubjectBounds(kind: string, screen: Position, radius: number): void {
  invariant(
    screen.x - radius >= 10 &&
      screen.x + radius <= WIDTH - 10 &&
      screen.y - radius >= 70 &&
      screen.y + radius <= HEIGHT - 40,
    `${kind} left the readable play area at (${screen.x.toFixed(1)}, ${screen.y.toFixed(1)})`
  );
}

function secondsLabel(frames: number): string {
  return `${Math.max(0, frames / GAME.FPS).toFixed(1)} s`;
}

function drawFrameChrome(
  ctx: RenderContext,
  title: string,
  detail: string,
  frame: number,
  accent: string = TITLE.ACCENT
): void {
  ctx.save();
  ctx.fillStyle = PALETTE.BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  let state = STAR_SEED;
  for (let index = 0; index < 90; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const x = (((value ^ (value >>> 14)) >>> 0) / 4294967296) * WIDTH;
    state = (state + 0x6d2b79f5) >>> 0;
    value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const y = (((value ^ (value >>> 14)) >>> 0) / 4294967296) * HEIGHT;
    ctx.fillStyle = `rgba(139,163,199,${0.18 + ((index % 5) * 0.08).toFixed(2)})`;
    ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }

  ctx.fillStyle = PALETTE.HUD;
  ctx.font = '700 22px Arial';
  ctx.fillText(title, 22, 30);
  ctx.fillStyle = accent;
  ctx.fillRect(22, 40, 74, 2);
  ctx.fillStyle = PALETTE.HUD_MUTED;
  ctx.font = '18px Arial';
  ctx.fillText(detail, 22, 62);
  ctx.font = '16px Arial';
  ctx.fillText(`controlled demonstration · ${((frame + 1) / FPS).toFixed(1)} s`, 22, HEIGHT - 17);
  ctx.restore();
}

function drawTag(
  ctx: RenderContext,
  text: string,
  x: number,
  y: number,
  color: string = PALETTE.HUD
): void {
  ctx.save();
  ctx.font = '600 20px Arial';
  const width = ctx.measureText(text).width + 28;
  const left = Math.max(10, Math.min(x - 12, WIDTH - width - 10));
  ctx.fillStyle = 'rgba(0,0,17,0.84)';
  ctx.fillRect(left, y - 28, width, 36);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.65;
  ctx.strokeRect(left, y - 28, width, 36);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, left + 14, y - 5);
  ctx.restore();
}

function drawShip(
  ctx: RenderContext,
  kitId: ShipKitId,
  position: Position,
  angle: number,
  color = PALETTE.LOCAL,
  radius = getShipKit(kitId).size / 2,
  thrusting = false
): void {
  const screen = screenPoint(position);
  assertSubjectBounds(`${kitId} hull`, screen, radius);
  renderHull(ctx, screen.x, screen.y, radius, angle, color, kitId);
  if (!thrusting) {
    return;
  }
  const aft = getKitHullOutline(kitId).thruster;
  const rear = projectHullPoint(screen.x, screen.y, radius, angle, aft);
  const flame = thrusterFlameGeometry(screen.x, screen.y, angle, radius, 0.72, 0.42, rear);
  renderPolyline(ctx, [flame.left, flame.tip, flame.right], PALETTE.LASER_LOCAL, 1.2, 3, false);
  renderPolyline(
    ctx,
    [flame.coreLeft, flame.coreTip, flame.coreRight],
    PALETTE.HUD,
    0.9,
    1.5,
    false
  );
}

function drawRoid(
  ctx: RenderContext,
  rock: Pick<
    AsteroidData,
    | 'position'
    | 'size'
    | 'rotation'
    | 'vertices'
    | 'offsets'
    | 'material'
    | 'health'
    | 'maxHealth'
    | 'phenomenon'
    | 'spinClass'
  >,
  scale = 1,
  alpha = 1
): void {
  const screen = screenPoint(rock.position, scale);
  const radius = rock.size * scale;
  assertSubjectBounds(`${rock.material} asteroid`, screen, radius);
  const points = polygonPoints(
    screen.x,
    screen.y,
    radius,
    rock.rotation,
    rock.vertices,
    rock.offsets
  );
  ctx.save();
  ctx.globalAlpha = alpha;
  renderPolyline(ctx, points, PALETTE.ROID, Math.max(1, radius * 0.045), VISUAL.ROID_GLOW, true);
  if (rock.material) {
    renderMaterial(
      ctx,
      rock.material,
      screen.x,
      screen.y,
      radius,
      rock.rotation,
      rock.maxHealth > 0 ? rock.health / rock.maxHealth : 1
    );
  }
  const cues: Pick<AsteroidData, 'phenomenon' | 'spinClass'> = {};
  if (rock.phenomenon !== undefined) {
    cues.phenomenon = rock.phenomenon;
  }
  if (rock.spinClass !== undefined) {
    cues.spinClass = rock.spinClass;
  }
  renderRoidCue(ctx, cues, radius, screen.x, screen.y);
  ctx.restore();
}

function drawLaser(
  ctx: RenderContext,
  position: Position,
  velocity: Velocity,
  color: string = PALETTE.LASER_LOCAL
): void {
  const screen = screenPoint(position);
  const speed = Math.hypot(velocity.x, velocity.y) || 1;
  const dx = velocity.x / speed;
  const dy = velocity.y / speed;
  renderSegment(
    ctx,
    screen.x - dx * 9,
    screen.y - dy * 9,
    screen.x + dx * 9,
    screen.y + dy * 9,
    color,
    VISUAL.LASER_STROKE_WIDTH,
    VISUAL.LASER_GLOW
  );
}

function drawArrow(
  ctx: RenderContext,
  from: Position,
  velocity: Velocity,
  color: string = PALETTE.LASER_LOCAL,
  scale = 4
): void {
  const start = screenPoint(from);
  const end = { x: start.x + velocity.x * scale, y: start.y + velocity.y * scale };
  renderSegment(ctx, start.x, start.y, end.x, end.y, color, 1.4, 2.5);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  renderSegment(
    ctx,
    end.x,
    end.y,
    end.x - Math.cos(angle - 0.45) * 7,
    end.y - Math.sin(angle - 0.45) * 7,
    color,
    1.2,
    2
  );
  renderSegment(
    ctx,
    end.x,
    end.y,
    end.x - Math.cos(angle + 0.45) * 7,
    end.y - Math.sin(angle + 0.45) * 7,
    color,
    1.2,
    2
  );
}

function drawRing(
  ctx: RenderContext,
  position: Position,
  radius: number,
  color: string,
  alpha = 0.8
): void {
  const screen = screenPoint(position);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = VISUAL.SHIELD_GLOW;
  ctx.lineWidth = VISUAL.SHIELD_STROKE_WIDTH;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawCable(
  ctx: RenderContext,
  from: Position,
  to: Position,
  color: string = '#E8D5A3'
): void {
  const start = screenPoint(from);
  const end = screenPoint(to);
  renderSegment(ctx, start.x, start.y, end.x, end.y, color, 1.5, 2.5);
  ctx.save();
  ctx.strokeStyle = '#FDE68A';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(end.x, end.y, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function makeAbilityHost(kitId: ShipKitId, position: Position, angle = 0): AbilityHost {
  return {
    id: `${kitId}-demo-host`,
    kitId,
    position,
    velocity: { x: 0, y: 0 },
    angle,
    exploding: false,
    health: getShipKit(kitId).maxHealth,
    fuel: FUEL.START,
    maxFuel: FUEL.MAX,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    shieldTimer: 0,
    harpoonTimer: 0,
    r: getShipKit(kitId).size / 2,
  };
}

function makeAsteroid(
  id: string,
  position: Position,
  size: number,
  material: 'ice' | 'metal' | 'rubble',
  rotation = 0
): AsteroidData {
  const offsets =
    material === 'ice'
      ? [1, 0.76, 1.08, 0.84, 1, 0.72]
      : material === 'metal'
        ? [0.94, 1, 0.9, 0.97, 0.93, 1, 0.9, 0.98]
        : [1, 0.58, 0.86, 0.72, 1.1, 0.64, 0.95, 0.56, 1.02, 0.74, 0.88, 0.62];
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size,
    jaggedness: material === 'rubble' ? 0.7 : 0.25,
    rotation,
    angularVelocity: 0,
    health: material === 'metal' ? 75 : 100,
    maxHealth: material === 'metal' ? 75 : 100,
    vertices: offsets.length,
    offsets,
    material,
  };
}

function makeDartDemo(): Demo {
  const host = makeAbilityHost('dart', { x: -150, y: 28 });
  const start = copyPosition(host.position);
  const result = activateAbilityOnHost(host);
  invariant(
    result.activated && result.abilityId === 'boostDash',
    'Dart E did not activate boostDash'
  );
  invariant(
    host.velocity.x > 0 && host.velocity.y === 0,
    'Dart boost did not add forward velocity'
  );
  const movingHost: AbilityHost = {
    ...host,
    position: copyPosition(host.position),
    velocity: { ...host.velocity },
  };
  const positions: Position[] = [copyPosition(movingHost.position)];
  const speeds: number[] = [Math.hypot(movingHost.velocity.x, movingHost.velocity.y)];
  const activeFrames: number[] = [movingHost.abilityActiveFrames];
  const totalTicks = (FRAME_COUNT - 1) * SIM_TICKS_PER_FRAME;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    movingHost.position.x += movingHost.velocity.x;
    movingHost.position.y += movingHost.velocity.y;
    movingHost.velocity = applyThrustOrFriction(
      movingHost.velocity,
      movingHost.angle,
      false,
      moveFrictionForShip(false),
      SHIP.THRUST,
      1,
      SHIP.MAX_VELOCITY
    );
    tickAbilityHost(movingHost);
    if ((tick + 1) % SIM_TICKS_PER_FRAME === 0) {
      positions.push(copyPosition(movingHost.position));
      speeds.push(Math.hypot(movingHost.velocity.x, movingHost.velocity.y));
      activeFrames.push(movingHost.abilityActiveFrames);
    }
  }
  return {
    id: 'dart',
    posterFrame: 10,
    verify: () => {
      invariant(activeFrames[0] === 12, 'Dart active window changed');
      invariant(
        positions.some((position, index) => position.x > start.x && (index ?? 0) > 0),
        'Dart did not advance after the boost'
      );
      invariant((speeds.at(-1) ?? 0) < (speeds[0] ?? 0), 'Dart drift did not slow under friction');
    },
    render: (ctx, frame) => {
      drawFrameChrome(ctx, 'DART · BOOST DASH', 'E trigger → short burst → drift', frame);
      const displayScale = 0.5;
      const position = positions[frame] ?? positions[0] ?? start;
      const pathStart = screenPoint(positions[Math.max(0, frame - 8)] ?? start, displayScale);
      const pathEnd = screenPoint(position, displayScale);
      renderSegment(ctx, pathStart.x, pathStart.y, pathEnd.x, pathEnd.y, PALETTE.LOCAL, 1, 2);
      drawShip(
        ctx,
        'dart',
        { x: position.x * displayScale, y: position.y * displayScale },
        0,
        PALETTE.LOCAL,
        getShipKit('dart').size / 2,
        (activeFrames[frame] ?? 0) > 0
      );
      drawTag(
        ctx,
        (activeFrames[frame] ?? 0) > 0 ? 'E · boost active' : 'drift · friction slows',
        380,
        112,
        PALETTE.LOCAL
      );
      drawTag(ctx, `speed ${speeds[frame]?.toFixed(2) ?? '0.00'}`, 440, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeHaulerDemo(): Demo {
  const host = makeAbilityHost('hauler', { x: -130, y: 16 });
  const target: AbilityBody = {
    id: 'demo-rock',
    kind: 'asteroid',
    position: { x: 120, y: 16 },
    velocity: { x: 0, y: 0 },
    size: 34,
  };
  const world: AbilityWorld = {
    asteroids: [target],
    entities: [],
    canvas: { width: WIDTH, height: HEIGHT },
    playfieldScale: 1,
  };
  const result = activateAbilityOnHost(host, world);
  invariant(
    result.activated && result.abilityId === 'harpoon',
    'Hauler E did not latch a nearby rock'
  );
  invariant(host.harpoonTargetId === target.id, 'Hauler selected the wrong target');
  let pullTicks = 0;
  return {
    id: 'hauler',
    posterFrame: 14,
    verify: () =>
      invariant(pullTicks > 0 && target.position.x < 120, 'Hauler tether did not pull the target'),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'HAULER · HARPOON',
        'E trigger → latch nearest valid body → pull',
        frame,
        '#FDE68A'
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          pullHarpoonTarget(host, world.asteroids);
          target.position.x += target.velocity.x;
          target.position.y += target.velocity.y;
          tickAbilityHost(host);
          pullTicks += 1;
        });
      }
      const midpoint = {
        x: (host.position.x + target.position.x) / 2,
        y: (host.position.y + target.position.y) / 2,
      };
      const span = Math.max(
        Math.abs(target.position.x - host.position.x),
        Math.abs(target.position.y - host.position.y),
        1
      );
      const displayScale = Math.min(0.4, 230 / span);
      drawRoid(
        ctx,
        {
          position: {
            x: target.position.x - midpoint.x,
            y: target.position.y - midpoint.y,
          },
          size: target.size ?? 34,
          rotation: 0,
          vertices: 8,
          offsets: [1, 0.8, 1.05, 0.92, 1, 0.78, 1.04, 0.88],
          material: 'metal',
          health: 75,
          maxHealth: 75,
        },
        displayScale
      );
      const displayHost = {
        x: (host.position.x - midpoint.x) * displayScale,
        y: (host.position.y - midpoint.y) * displayScale,
      };
      const displayTarget = {
        x: (target.position.x - midpoint.x) * displayScale,
        y: (target.position.y - midpoint.y) * displayScale,
      };
      if (host.harpoonTimer > 0) {
        drawCable(ctx, displayHost, displayTarget);
      }
      drawShip(ctx, 'hauler', displayHost, 0, PALETTE.LOCAL, getShipKit('hauler').size / 2);
      drawTag(
        ctx,
        host.harpoonTimer > 0 ? 'cable active · pulling rock' : 'cable released · rock coasts',
        310,
        110,
        '#FDE68A'
      );
      drawTag(ctx, 'hook → pull → release', 400, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeWardenDemo(): Demo {
  const host = makeAbilityHost('warden', { x: -40, y: 18 });
  const result = activateAbilityOnHost(host);
  invariant(
    result.activated && result.abilityId === 'shieldFocus',
    'Warden E did not activate shieldFocus'
  );
  let sawExpired = false;
  let contactResolved = false;
  let laserAbsorbed = false;
  const contactFrame = 14;
  const laserStart = { x: -200, y: host.position.y };
  return {
    id: 'warden',
    posterFrame: 10,
    verify: () => {
      invariant(sawExpired, 'Warden shield timer did not expire after the shown duration');
      invariant(laserAbsorbed, 'Warden shield did not absorb the incoming laser');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'WARDEN · SHIELD FOCUS',
        'E trigger → shield meets an incoming laser',
        frame,
        PALETTE.SHIELD
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          tickAbilityHost(host);
          sawExpired ||= host.shieldTimer <= 0;
        });
      }
      if (!contactResolved && frame >= contactFrame) {
        laserAbsorbed = absorbDamageWithShield(host);
        contactResolved = true;
      }
      const shieldUp = host.shieldTimer > 0;
      const position = host.position;
      if (shieldUp) {
        drawRing(ctx, position, 34, PALETTE.SHIELD, 0.92);
      }
      drawShip(ctx, 'warden', position, 0, PALETTE.LOCAL, getShipKit('warden').size / 2);
      const contactProgress = Math.min(1, frame / contactFrame);
      const laser = {
        x: laserStart.x + (position.x - laserStart.x) * contactProgress,
        y: laserStart.y,
      };
      if (!contactResolved || frame === contactFrame) {
        drawLaser(ctx, laser, { x: 5, y: 0 }, PALETTE.LASER_ENEMY);
      }
      if (frame === contactFrame && laserAbsorbed) {
        drawRing(ctx, position, 43, PALETTE.SHIELD, 0.9);
      }
      drawTag(ctx, `E shield · ${secondsLabel(host.shieldTimer)}`, 380, 112, PALETTE.SHIELD);
      drawTag(
        ctx,
        frame < contactFrame
          ? 'laser approaching'
          : laserAbsorbed
            ? 'laser absorbed'
            : 'shield expired · laser hit hull',
        365,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makeSkirmisherDemo(): Demo {
  const host = makeAbilityHost('skirmisher', { x: -140, y: 42 }, 0);
  const result = activateAbilityOnHost(host);
  invariant(
    result.activated && result.abilityId === 'burstFire',
    'Skirmisher E did not activate burstFire'
  );
  const kit = getShipKit('skirmisher');
  const shots = Array.from({ length: kit.burstCount }, (_, index) => {
    const mid = (kit.burstCount - 1) / 2;
    const angle = host.angle + (index - mid) * SHIP_ABILITY.BURST_SPREAD;
    return {
      position: { ...host.position },
      velocity: laserVelocityFromAngle(angle, host.velocity),
    };
  });
  invariant(shots.length === 3, 'Skirmisher burst count changed');
  return {
    id: 'skirmisher',
    posterFrame: 8,
    verify: () => invariant(host.abilityActiveFrames === 8, 'Skirmisher active window changed'),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SKIRMISHER · BURST FIRE',
        'E trigger → three-shot narrow volley',
        frame,
        PALETTE.LASER_LOCAL
      );
      drawShip(
        ctx,
        'skirmisher',
        host.position,
        host.angle,
        PALETTE.LOCAL,
        getShipKit('skirmisher').size / 2
      );
      for (const shot of shots) {
        const position = {
          x: shot.position.x + shot.velocity.x * frame * 2.1,
          y: shot.position.y + shot.velocity.y * frame * 2.1,
        };
        drawLaser(ctx, position, shot.velocity);
      }
      drawTag(ctx, 'three lasers · narrow spread', 340, 112, PALETTE.LASER_LOCAL);
      drawTag(ctx, 'volley travels together', 394, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeQuakeDemo(): Demo {
  const host = makeAbilityHost('quake', { x: 0, y: 0 });
  const rocks: AbilityBody[] = [
    {
      id: 'quake-ice',
      kind: 'asteroid',
      position: { x: -92, y: -44 },
      velocity: { x: 0, y: 0 },
      size: 24,
    },
    {
      id: 'quake-metal',
      kind: 'asteroid',
      position: { x: 84, y: 54 },
      velocity: { x: 0, y: 0 },
      size: 36,
    },
  ];
  const world: AbilityWorld = {
    asteroids: rocks,
    entities: [],
    canvas: { width: WIDTH, height: HEIGHT },
  };
  const result = activateAbilityOnHost(host, world);
  invariant(
    result.activated && result.abilityId === 'shockPulse',
    'Quake E did not activate shockPulse'
  );
  invariant(host.fuel === FUEL.START - FUEL.EMP_COST, 'Quake did not spend EMP fuel');
  invariant(
    rocks.some((rock) => Math.hypot(rock.velocity.x, rock.velocity.y) > 0),
    'Quake did not push a nearby rock'
  );
  const startingPositions = rocks.map((rock) => ({ ...rock.position }));
  return {
    id: 'quake',
    posterFrame: 2,
    verify: () =>
      invariant(
        rocks.some(
          (rock, index) =>
            Math.hypot(
              rock.position.x - (startingPositions[index]?.x ?? 0),
              rock.position.y - (startingPositions[index]?.y ?? 0)
            ) > 0
        ),
        'Quake rocks did not move after the pulse'
      ),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'QUAKE · SHOCK PULSE',
        'E trigger → EMP fuel spend → radial push',
        frame,
        '#67E8F9'
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          for (const rock of rocks) {
            rock.position.x += rock.velocity.x;
            rock.position.y += rock.velocity.y;
          }
          tickAbilityHost(host);
        });
      }
      for (const [index, rock] of rocks.entries()) {
        drawRoid(
          ctx,
          {
            position: rock.position,
            size: rock.size ?? 24,
            rotation: index * 0.5,
            vertices: 8,
            offsets: [1, 0.8, 1.05, 0.92, 1, 0.78, 1.04, 0.88],
            material: index === 0 ? 'ice' : 'metal',
            health: 100,
            maxHealth: 100,
          },
          0.32
        );
        drawArrow(
          ctx,
          { x: rock.position.x * 0.32, y: rock.position.y * 0.32 },
          { x: rock.velocity.x * 0.32, y: rock.velocity.y * 0.32 },
          '#67E8F9',
          5
        );
      }
      if (host.abilityActiveFrames > 0) {
        drawRing(ctx, { x: 0, y: 0 }, Math.min(110, frame * 45), '#67E8F9', 0.8);
      }
      drawShip(ctx, 'quake', host.position, 0, PALETTE.LOCAL, getShipKit('quake').size / 2);
      drawTag(ctx, `EMP · fuel ${host.fuel}/${host.maxFuel}`, 350, 112, '#67E8F9');
      drawTag(
        ctx,
        host.abilityActiveFrames > 0 ? 'pulse active · rocks pushed' : 'pulse ended · rocks coast',
        340,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makeMovementDemo(): Demo {
  const state = {
    position: { x: -165, y: 58 },
    velocity: { x: 0, y: 0 },
  };
  const positions: Position[] = [copyPosition(state.position)];
  const speeds: number[] = [0];
  const totalTicks = FRAME_COUNT * SIM_TICKS_PER_FRAME;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    state.velocity = applyThrustOrFriction(
      state.velocity,
      0,
      tick < 12 * SIM_TICKS_PER_FRAME,
      moveFrictionForShip(false),
      SHIP.THRUST,
      1,
      SHIP.MAX_VELOCITY
    );
    state.position.x += state.velocity.x;
    state.position.y += state.velocity.y;
    if ((tick + 1) % SIM_TICKS_PER_FRAME === 0) {
      positions.push(copyPosition(state.position));
      speeds.push(Math.hypot(state.velocity.x, state.velocity.y));
    }
  }
  const initialSpeed = speeds[0] ?? 0;
  const thrustSpeed = speeds[10] ?? 0;
  const releaseSpeed = speeds[12] ?? 0;
  const finalSpeed = speeds[47] ?? 0;
  invariant(thrustSpeed > initialSpeed, 'movement thrust did not accelerate');
  invariant(finalSpeed < releaseSpeed, 'movement friction did not slow drift');
  return {
    id: 'movement',
    posterFrame: 12,
    verify: () => invariant(positions.length === FRAME_COUNT + 1, 'movement frame count changed'),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'MOVEMENT · THRUST + DRIFT',
        'hold thrust → accelerate · release → friction coasts',
        frame,
        PALETTE.LOCAL
      );
      const position = positions[frame + 1] ?? positions[0] ?? { x: 0, y: 0 };
      const trailStart = positions[Math.max(0, frame - 9)] ?? position;
      const displayScale = 0.4;
      const a = screenPoint(trailStart, displayScale);
      const b = screenPoint(position, displayScale);
      renderSegment(ctx, a.x, a.y, b.x, b.y, PALETTE.LOCAL, 1, 2);
      drawShip(
        ctx,
        'dart',
        { x: position.x * displayScale, y: position.y * displayScale },
        0,
        PALETTE.LOCAL,
        getShipKit('dart').size / 2,
        frame < 12
      );
      drawTag(
        ctx,
        frame < 12 ? 'ArrowUp held · thrust' : 'released · friction',
        350,
        112,
        PALETTE.LOCAL
      );
      drawTag(ctx, `speed ${speeds[frame + 1]?.toFixed(2) ?? '0.00'}`, 470, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeTerrainDemo(): Demo {
  const field = createHeightfield(0x7ec01d, { radius: getGameBoundary().radius });
  const candidates: Position[] = [
    { x: 720, y: 410 },
    { x: -720, y: 410 },
    { x: 620, y: -520 },
    { x: -620, y: -520 },
  ];
  const start = candidates.find((candidate) => {
    const gradient = sampleGradient(field, candidate.x, candidate.y);
    return Math.hypot(gradient.x, gradient.y) > 0.0001;
  });
  if (start === undefined) {
    throw new Error('wiki-media verification failed: terrain field has no measurable slope');
  }
  const contours = extractIsoContours(field);
  const state = {
    position: copyPosition(start),
    velocity: { x: 0, y: 0 },
  };
  const initialGradient = sampleGradient(field, state.position.x, state.position.y);
  const gradients: number[] = [Math.hypot(initialGradient.x, initialGradient.y)];
  let sawSlopeMotion = false;
  return {
    id: 'terrain',
    posterFrame: 20,
    verify: () => {
      invariant(contours.length > 0, 'terrain contour extraction returned no levels');
      invariant(sawSlopeMotion, 'terrain slope force did not move the ship');
      invariant(
        gradients.some((gradient) => gradient > 0.0001),
        'terrain gradient samples were flat'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'TERRAIN · SLOPE FORCE',
        'contours → downhill acceleration',
        frame,
        PALETTE.CONTOUR
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          const kit = getShipKit('dart');
          state.velocity = applyThrustOrFriction(
            state.velocity,
            0,
            false,
            moveFrictionForShip(false),
            kit.thrust,
            1,
            kit.maxVelocity
          );
          applySlopeForce(state.velocity, state.position, field);
          state.position.x += state.velocity.x;
          state.position.y += state.velocity.y;
          if (Math.hypot(state.velocity.x, state.velocity.y) > 0) {
            sawSlopeMotion = true;
          }
        });
        const gradient = sampleGradient(field, state.position.x, state.position.y);
        gradients.push(Math.hypot(gradient.x, gradient.y));
      }
      const contourScale = 0.18;
      for (const level of contours) {
        for (const segment of level.segments) {
          const a = screenPoint(
            { x: segment.ax - state.position.x, y: segment.ay - state.position.y },
            contourScale
          );
          const b = screenPoint(
            { x: segment.bx - state.position.x, y: segment.by - state.position.y },
            contourScale
          );
          if (
            (a.y < 72 && b.y < 72) ||
            (a.y > HEIGHT - 40 && b.y > HEIGHT - 40) ||
            (a.x < 0 && b.x < 0) ||
            (a.x > WIDTH && b.x > WIDTH)
          ) {
            continue;
          }
          renderSegment(
            ctx,
            a.x,
            a.y,
            b.x,
            b.y,
            PALETTE.CONTOUR,
            level.index % 3 === 0 ? 1.1 : 0.65,
            0.5
          );
        }
      }
      ctx.save();
      ctx.translate(0, 72);
      drawContourLabels(ctx, contours, {
        width: WIDTH,
        height: HEIGHT - 112,
        x: state.position.x,
        y: state.position.y + 16 / contourScale,
        scale: contourScale,
        alpha: VISUAL.CONTOUR_LABEL_ALPHA,
        spacing: VISUAL.CONTOUR_LABEL_SPACING / contourScale,
      });
      ctx.restore();
      const gradient = sampleGradient(field, state.position.x, state.position.y);
      const steepness = Math.hypot(gradient.x, gradient.y);
      const directionScale = steepness > 0 ? 64 / steepness : 0;
      drawShip(ctx, 'dart', { x: 0, y: 0 }, 0, PALETTE.LOCAL, getShipKit('dart').size / 2, false);
      drawArrow(
        ctx,
        { x: 0, y: 0 },
        { x: -gradient.x * directionScale, y: -gradient.y * directionScale },
        PALETTE.CONTOUR,
        1
      );
      drawTag(
        ctx,
        `height ${sampleHeight(field, state.position.x, state.position.y).toFixed(2)}`,
        370,
        112,
        PALETTE.CONTOUR
      );
      drawTag(ctx, 'arrow shows downhill', 390, 286, PALETTE.HUD_MUTED);
    },
  };
}

function drawLootDiamond(
  ctx: RenderContext,
  position: Position,
  radius: number,
  color: string,
  alpha = 1,
  scale = 1
): void {
  const screen = screenPoint(position, scale);
  const screenRadius = lootScreenRadius(radius, scale);
  if (screenRadius === null) {
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 4;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(screen.x, screen.y - screenRadius);
  ctx.lineTo(screen.x + screenRadius, screen.y);
  ctx.lineTo(screen.x, screen.y + screenRadius);
  ctx.lineTo(screen.x - screenRadius, screen.y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function makeLootDemo(): Demo {
  const displayScale = 0.28;
  const lootManager = new LootManager(new RNGService(0x55aa1122));
  const firstDrop = lootManager.spawnShard({ x: 0, y: 0 }, 0, 0.4);
  const secondDrop = lootManager.spawnShard({ x: 60, y: 0 }, 0, 0.25);
  const rock = makeAsteroid('loot-rock', { x: 44, y: 0 }, 22, 'rubble');
  const shooterStart = { x: -1000, y: 0 };
  const initialMass = 1;
  let mass = initialMass;
  let armed = false;
  let detonated = false;
  let collected = false;
  let firstRemoved = false;
  let secondVisible = false;
  let explosionFrame = -1;
  let contactFrame = -1;
  const blastVelocity = blastPush(firstDrop.position, rock.position);
  invariant(isSmallRoid(rock.size), 'loot demonstration rock left the small-roid band');
  invariant(
    inBlastRadius(firstDrop.position, rock.position, rock.size),
    'loot blast did not reach the nearby rock'
  );
  invariant(
    !inLootArmRange(shooterStart, firstDrop.position),
    'loot arm setup started inside the arm range'
  );
  const shipPositionAt = (frame: number): Position => {
    if (frame <= 12) {
      return { x: shooterStart.x + frame * 50, y: 0 };
    }
    return { x: -400 + (frame - 12) * 35, y: 0 };
  };
  return {
    id: 'loot',
    posterFrame: 26,
    verify: () => {
      invariant(armed, 'loot arm range was never reached');
      invariant(detonated, 'loot blast never triggered');
      invariant(firstRemoved && contactFrame >= 0, 'loot shot did not remove the first drop');
      invariant(collected && mass > initialMass, 'loot mass growth never applied');
      invariant(rock.position.x > 44, 'loot blast did not push the small rock');
      invariant(lootManager.get(secondDrop.id) === undefined, 'collected shard remained in loot');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'LOOT · ARM + GROWTH',
        'laser hits shard → blast pushes rock → collect a shard',
        frame,
        PALETTE.LOOT
      );
      const shooter = shipPositionAt(frame);
      armed ||= inLootArmRange(shooter, firstDrop.position);
      if (detonated) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          rock.position.x += rock.velocity.x;
          rock.position.y += rock.velocity.y;
        });
      }
      if (frame >= 8 && frame <= 12 && !firstRemoved) {
        const shotOrigin = shipPositionAt(8);
        const previous = { x: shotOrigin.x + (frame - 9) * 150, y: 0 };
        const current = { x: shotOrigin.x + (frame - 8) * 150, y: 0 };
        const contact = segmentCircleContact(
          previous,
          current,
          firstDrop.position,
          firstDrop.radius
        );
        if (contact !== undefined && armed) {
          const removed = lootManager.remove(firstDrop.id);
          if (removed !== undefined) {
            firstRemoved = true;
            detonated = inBlastRadius(removed.position, rock.position, rock.size);
            if (detonated) {
              rock.velocity = { ...blastVelocity };
              explosionFrame = frame;
              contactFrame = frame;
            }
          }
        }
      }
      if (detonated && frame >= 24) {
        secondVisible = true;
      }
      if (
        secondVisible &&
        !collected &&
        lootOverlap(shooter, mass, secondDrop.position, secondDrop.radius)
      ) {
        const removed = lootManager.remove(secondDrop.id);
        if (removed !== undefined) {
          collected = true;
          mass = applyLootMass(mass, removed.mass);
        }
      }
      const displayRockPosition = {
        x: rock.position.x * displayScale,
        y: rock.position.y * displayScale,
      };
      drawRoid(ctx, rock, displayScale);
      drawArrow(
        ctx,
        displayRockPosition,
        { x: rock.velocity.x * displayScale, y: rock.velocity.y * displayScale },
        PALETTE.LOOT,
        5
      );
      if (frame >= 8 && frame <= 12 && !firstRemoved) {
        const shotOrigin = shipPositionAt(8);
        const current = { x: shotOrigin.x + (frame - 8) * 150, y: 0 };
        drawLaser(
          ctx,
          { x: current.x * displayScale, y: current.y * displayScale },
          { x: 150 * displayScale, y: 0 }
        );
      }
      if (frame === contactFrame) {
        drawLaser(ctx, { x: 0, y: 0 }, { x: 150 * displayScale, y: 0 });
      }
      if (!firstRemoved) {
        drawLootDiamond(
          ctx,
          firstDrop.position,
          firstDrop.radius,
          lootStrokeColor(firstDrop.kind),
          1,
          displayScale
        );
      }
      if (secondVisible && !collected) {
        drawLootDiamond(
          ctx,
          secondDrop.position,
          secondDrop.radius,
          lootStrokeColor(secondDrop.kind),
          1,
          displayScale
        );
      }
      const blastAge = frame - explosionFrame;
      if (detonated && blastAge >= 0 && blastAge <= 12) {
        drawRing(
          ctx,
          { x: 0, y: 0 },
          Math.min(LOOT_BLAST.RADIUS * displayScale, (blastAge + 1) * 12),
          PALETTE.DANGER,
          Math.max(0, 0.8 - blastAge * 0.06)
        );
      }
      const shipRadius = radiusFromMass(mass);
      drawShip(
        ctx,
        'dart',
        { x: shooter.x * displayScale, y: shooter.y * displayScale },
        0,
        PALETTE.LOCAL,
        shipRadius,
        frame >= 8 && frame <= 12
      );
      drawTag(
        ctx,
        collected
          ? 'shard collected · ship grew'
          : detonated
            ? 'blast pushed the rock'
            : armed
              ? 'laser can reach the shard'
              : 'approach the shard',
        332,
        112,
        PALETTE.LOOT
      );
      drawTag(
        ctx,
        collected
          ? `ship size ${sizeScaleFromMass(mass).toFixed(2)}×`
          : secondVisible
            ? 'new shard ahead'
            : 'laser removes the first shard',
        350,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makeReflectionDemo(): Demo {
  const rock = makeAsteroid('reflector', { x: 88, y: 0 }, 42, 'metal');
  rock.phenomenon = {
    kind: 'reflective',
    clusterId: 'demo-cluster',
    energy: 0,
    maxEnergy: ASTEROID_INTERACTIONS.reflectiveEnergy,
  };
  const start = { x: -235, y: 0 };
  const preview = previewChargedReflections(start, { x: 1, y: 0 }, [rock], 500, 1);
  invariant(preview.impacts.length >= 1, 'reflection preview found no impact');
  invariant(preview.finalDirection.x < 0, 'reflection did not reverse the laser direction');
  return {
    id: 'reflection',
    posterFrame: 11,
    verify: () =>
      invariant(preview.segments.length >= 2, 'reflection path lacks a reflected segment'),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'REFLECTIVE ASTEROID',
        'faceted metal face → bounded specular reflection',
        frame,
        PALETTE.LASER_LOCAL
      );
      drawRoid(ctx, rock, 1);
      const progress = frame / (FRAME_COUNT - 1);
      const first = preview.segments[0];
      const second = preview.segments[1];
      if (first) {
        const firstProgress = Math.min(1, progress * 2.2);
        const position = {
          x: first.start.x + (first.end.x - first.start.x) * firstProgress,
          y: first.start.y + (first.end.y - first.start.y) * firstProgress,
        };
        renderSegment(
          ctx,
          screenPoint(first.start).x,
          screenPoint(first.start).y,
          screenPoint(position).x,
          screenPoint(position).y,
          PALETTE.LASER_LOCAL,
          2,
          3.5
        );
        if (progress > 0.48 && second) {
          const secondProgress = Math.min(1, (progress - 0.48) * 1.95);
          const reflected = {
            x: second.start.x + (second.end.x - second.start.x) * secondProgress,
            y: second.start.y + (second.end.y - second.start.y) * secondProgress,
          };
          renderSegment(
            ctx,
            screenPoint(second.start).x,
            screenPoint(second.start).y,
            screenPoint(reflected).x,
            screenPoint(reflected).y,
            PALETTE.LASER_LOCAL,
            2,
            3.5
          );
          drawLaser(ctx, reflected, preview.finalDirection);
        }
      }
      drawTag(ctx, 'laser bounces · energy grows', 340, 112, PALETTE.LASER_LOCAL);
      drawTag(ctx, 'bounce path stays finite', 370, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeShieldDemo(): Demo {
  const warden = makeAbilityHost('warden', { x: -90, y: 35 });
  const wardenResult = activateAbilityOnHost(warden);
  const regular = createShieldState();
  invariant(wardenResult.activated, 'shield comparison Warden lane did not activate');
  invariant(activateShield(regular), 'shield comparison F lane did not activate');
  invariant(isShieldBlockingLasers(regular), 'regular F shield is not laser blocking');
  let wardenExpired = false;
  let regularExpired = false;
  return {
    id: 'shield',
    posterFrame: 6,
    verify: () =>
      invariant(
        wardenExpired && regularExpired,
        'shield lanes did not show their full timed windows'
      ),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SHIELDS · E vs F',
        'two shields · different durations',
        frame,
        PALETTE.SHIELD
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          tickAbilityHost(warden);
          updateShield(regular);
          wardenExpired ||= warden.shieldTimer <= 0;
          regularExpired ||= regular.shieldTime <= 0;
        });
      }
      const wardenPosition = { x: -110, y: 35 };
      const regularPosition = { x: 110, y: 35 };
      if (warden.shieldTimer > 0) {
        drawRing(ctx, wardenPosition, 34, PALETTE.SHIELD, 0.9);
      }
      if (regular.shieldTime > 0) {
        drawRing(ctx, regularPosition, 34, PALETTE.SHIELD, 0.9);
      }
      drawShip(ctx, 'warden', wardenPosition, 0, PALETTE.LOCAL, getShipKit('warden').size / 2);
      drawShip(ctx, 'dart', regularPosition, 0, PALETTE.LOCAL, getShipKit('dart').size / 2);
      drawTag(
        ctx,
        `WARDEN E · ${warden.shieldTimer > 0 ? secondsLabel(warden.shieldTimer) : 'expired'}`,
        95,
        130,
        PALETTE.SHIELD
      );
      drawTag(
        ctx,
        `F shield · ${regular.shieldTime > 0 ? secondsLabel(regular.shieldTime) : 'expired'}`,
        320,
        130,
        PALETTE.SHIELD
      );
      drawTag(ctx, 'E lasts 3 s · F lasts 2 s', 260, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeSplitDemo(): Demo {
  const manager = new AsteroidManager(new RNGService(0x1234abcd));
  const original = makeAsteroid('split-target', { x: 0, y: 0 }, 60, 'ice');
  original.isCollabTarget = true;
  manager.addAsteroid(original);
  const first = manager.registerLaserHit(original.id, 'pilot-a', 0);
  invariant(
    first.outcome === 'tagged' && !first.split,
    'first cooperative hit did not tag the rock'
  );
  const second = manager.registerLaserHit(original.id, 'pilot-b', 500);
  invariant(
    second.split && second.newAsteroids.length === 2,
    'two pilots did not split the biggest rock'
  );
  const fragments = second.newAsteroids;
  const splitBodies = fragments.map((fragment) => ({
    ...fragment,
    position: { ...fragment.position },
    velocity: { ...fragment.velocity },
  }));
  const splitFrame = 7;
  let fastWaveApplied = false;
  let heavyWaveApplied = false;
  return {
    id: 'split',
    posterFrame: 12,
    verify: () => {
      invariant(
        splitBodies.every((fragment) => fragment.size < original.size),
        'split fragments were not smaller'
      );
      invariant(fastWaveApplied && heavyWaveApplied, 'split shockwave waves did not run');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'COOPERATIVE SPLIT',
        'two pilots → two smaller rocks',
        frame,
        PALETTE.LASER_LOCAL
      );
      if (frame < splitFrame) {
        drawRoid(ctx, original);
        drawLaser(ctx, { x: -150 + frame * 16, y: 0 }, { x: 5, y: 0 });
        drawLaser(ctx, { x: 150 - frame * 16, y: 0 }, { x: -5, y: 0 }, PALETTE.LASER_ENEMY);
        drawTag(ctx, frame < 4 ? 'pilot A hits' : 'pilot B hits', 365, 112, PALETTE.LASER_LOCAL);
      } else {
        if (!fastWaveApplied) {
          const wave = SHOCKWAVE_WAVES.find((candidate) => candidate.id === 'fast');
          if (wave !== undefined) {
            for (const fragment of splitBodies) {
              const nextVelocity = applyShockwaveToBody(fragment, { x: 0, y: 0 }, wave);
              if (nextVelocity !== null) {
                fragment.velocity = nextVelocity;
              }
            }
          }
          fastWaveApplied = true;
        }
        if (frame > splitFrame) {
          runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
            const ageTicks = (frame - splitFrame - 1) * SIM_TICKS_PER_FRAME + 1;
            if (!heavyWaveApplied && ageTicks >= 7) {
              const wave = SHOCKWAVE_WAVES.find((candidate) => candidate.id === 'heavy');
              if (wave !== undefined) {
                for (const fragment of splitBodies) {
                  const nextVelocity = applyShockwaveToBody(fragment, { x: 0, y: 0 }, wave);
                  if (nextVelocity !== null) {
                    fragment.velocity = nextVelocity;
                  }
                }
              }
              heavyWaveApplied = true;
            }
            for (const fragment of splitBodies) {
              const next = stepAsteroidMotion(fragment.position, fragment.velocity);
              fragment.position = next.position;
              fragment.velocity = next.velocity;
            }
          });
        }
        const minX = Math.min(...splitBodies.map((fragment) => fragment.position.x));
        const maxX = Math.max(...splitBodies.map((fragment) => fragment.position.x));
        const minY = Math.min(...splitBodies.map((fragment) => fragment.position.y));
        const maxY = Math.max(...splitBodies.map((fragment) => fragment.position.y));
        const center = {
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
        };
        const maxSize = Math.max(...splitBodies.map((fragment) => fragment.size));
        const displayScale = Math.min(
          1,
          440 / (maxX - minX + 2 * maxSize + 40),
          130 / (maxY - minY + 2 * maxSize + 40)
        );
        for (const fragment of splitBodies) {
          drawRoid(
            ctx,
            {
              ...fragment,
              position: {
                x: fragment.position.x - center.x,
                y: fragment.position.y - center.y,
              },
            },
            displayScale
          );
        }
        const ageMs = ((frame - splitFrame) * SIM_TICKS_PER_FRAME * 1000) / GAME.FPS;
        for (const wave of SHOCKWAVE_WAVES) {
          const progress = waveVisualProgress(ageMs, wave);
          if (progress === null) {
            continue;
          }
          const color = wave.id === 'fast' ? PALETTE.LASER_LOCAL : PALETTE.LOCAL;
          drawRing(
            ctx,
            { x: -center.x, y: -center.y },
            easedRingRadius(progress, wave.radius) * displayScale,
            color,
            ringAlpha(progress, wave.id === 'fast' ? 0.82 : 1)
          );
        }
        drawTag(ctx, 'two smaller rocks', 355, 112, PALETTE.LASER_LOCAL);
      }
      drawTag(ctx, 'two hits → two rocks', 380, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeSlingshotDemo(): Demo {
  const rock = makeAsteroid('slingshot-rock', { x: 0, y: 0 }, 45, 'metal');
  const initialShip = { x: 90, y: 0 };
  const surface = asteroidSurfaceLatch(rock, initialShip);
  const latchRadius = surface.radius + getShipKit('hauler').size / 2 + 6;
  const initialRadial = rock.rotation + surface.angle;
  const omega = 0.1;
  const ship = {
    position: { ...initialShip },
    velocity: { x: 0, y: 0 },
    angle: 0,
  };
  const attachedSpeeds: number[] = [];
  for (let frame = 0; frame < 15; frame += 1) {
    rock.rotation += rock.angularVelocity * SIM_TICKS_PER_FRAME;
    const radial = initialRadial + omega * frame * SIM_TICKS_PER_FRAME;
    const offset = { x: Math.cos(radial) * latchRadius, y: Math.sin(radial) * latchRadius };
    ship.position = { x: offset.x, y: offset.y };
    ship.velocity = tangentVelocity(rock.velocity, offset, omega);
    attachedSpeeds.push(Math.hypot(ship.velocity.x, ship.velocity.y));
  }
  const releasePosition = copyPosition(ship.position);
  const releaseVelocity = { ...ship.velocity };
  invariant(
    attachedSpeeds[0] !== undefined && attachedSpeeds[0] > 0,
    'slingshot tangent velocity is empty'
  );
  return {
    id: 'slingshot',
    posterFrame: 10,
    verify: () => {
      const released = {
        position: { ...releasePosition },
        velocity: { ...releaseVelocity },
        angle: 0,
      };
      for (let frame = 0; frame < 8; frame += 1) {
        stepReleasedMotion(
          released,
          { thrust: false, turn: 0, aimAngle: 0 },
          0,
          getShipKit('hauler').turnSpeed,
          1
        );
      }
      invariant(
        Math.hypot(released.velocity.x, released.velocity.y) <
          Math.hypot(releaseVelocity.x, releaseVelocity.y),
        'release drag did not bound slingshot speed'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'HAULER · SLINGSHOT',
        'latch → spin → release with bounded tangential boost',
        frame,
        '#FDE68A'
      );
      const displayScale = 0.5;
      let position: Position;
      let velocity: Velocity;
      if (frame < 15) {
        const radial = initialRadial + omega * frame * SIM_TICKS_PER_FRAME;
        const offset = { x: Math.cos(radial) * latchRadius, y: Math.sin(radial) * latchRadius };
        position = offset;
        velocity = tangentVelocity(rock.velocity, offset, omega);
        drawCable(
          ctx,
          { x: 0, y: 0 },
          { x: position.x * displayScale, y: position.y * displayScale }
        );
      } else {
        const released = {
          position: { ...releasePosition },
          velocity: { ...releaseVelocity },
          angle: 0,
        };
        const releaseFrames = frame - 14;
        for (let tick = 0; tick < releaseFrames * SIM_TICKS_PER_FRAME; tick += 1) {
          stepReleasedMotion(
            released,
            { thrust: false, turn: 0, aimAngle: 0 },
            0,
            getShipKit('hauler').turnSpeed,
            1
          );
        }
        position = released.position;
        velocity = released.velocity;
      }
      const camera = frame < 15 ? { x: 0, y: 0 } : { x: position.x * 0.55, y: position.y * 0.55 };
      drawRoid(ctx, { ...rock, position: { x: -camera.x, y: -camera.y } }, displayScale);
      const displayPosition = {
        x: (position.x - camera.x) * displayScale,
        y: (position.y - camera.y) * displayScale,
      };
      drawShip(ctx, 'hauler', displayPosition, 0, PALETTE.LOCAL, getShipKit('hauler').size / 2);
      drawArrow(
        ctx,
        displayPosition,
        { x: velocity.x * displayScale, y: velocity.y * displayScale },
        '#FDE68A',
        5
      );
      drawTag(
        ctx,
        frame < 15 ? 'spin · ship follows rock' : 'released · momentum carries ship',
        330,
        112,
        '#FDE68A'
      );
      drawTag(ctx, 'latch, spin, release', 405, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeWinchDemo(): Demo {
  const primary = makeAsteroid('winch-primary', { x: -70, y: 0 }, 42, 'metal');
  const payload = makeAsteroid('winch-payload', { x: 78, y: 0 }, 28, 'ice');
  primary.angularVelocity = 0.03;
  const primaryMass = asteroidInertia(primary) + 1 * 60 ** 2;
  let released = false;
  return {
    id: 'winch',
    posterFrame: 11,
    verify: () => {
      const verificationPrimary = {
        ...primary,
        position: { ...primary.position },
        velocity: { ...primary.velocity },
      };
      const verificationPayload = {
        ...payload,
        position: { ...payload.position },
        velocity: { ...payload.velocity },
      };
      for (let frame = 0; frame < 8; frame += 1) {
        coupleAsteroidMomentum(verificationPrimary, verificationPayload, primaryMass, 1);
      }
      invariant(
        Math.hypot(verificationPayload.velocity.x, verificationPayload.velocity.y) > 0,
        'winch did not couple payload momentum'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'HAULER · WINCH',
        'anchor second rock → couple momentum → release',
        frame,
        '#FDE68A'
      );
      if (frame < 15) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          coupleAsteroidMomentum(primary, payload, primaryMass, 1);
        });
      } else if (!released) {
        released = true;
      }
      if (released) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          primary.position = {
            x: primary.position.x + primary.velocity.x,
            y: primary.position.y + primary.velocity.y,
          };
          payload.position = {
            x: payload.position.x + payload.velocity.x,
            y: payload.position.y + payload.velocity.y,
          };
        });
      }
      const minX = Math.min(primary.position.x, payload.position.x);
      const maxX = Math.max(primary.position.x, payload.position.x);
      const minY = Math.min(primary.position.y, payload.position.y);
      const maxY = Math.max(primary.position.y, payload.position.y);
      const center = {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
      };
      const maxSize = Math.max(primary.size, payload.size);
      const displayScale = Math.min(
        1,
        440 / (maxX - minX + 2 * maxSize + 40),
        130 / (maxY - minY + 2 * maxSize + 40)
      );
      const displayPrimary = {
        x: primary.position.x - center.x,
        y: primary.position.y - center.y,
      };
      const displayPayload = {
        x: payload.position.x - center.x,
        y: payload.position.y - center.y,
      };
      drawRoid(ctx, { ...primary, position: displayPrimary }, displayScale);
      drawRoid(ctx, { ...payload, position: displayPayload }, displayScale);
      if (frame < 15) {
        drawCable(
          ctx,
          { x: displayPrimary.x * displayScale, y: displayPrimary.y * displayScale },
          { x: displayPayload.x * displayScale, y: displayPayload.y * displayScale }
        );
      }
      drawArrow(
        ctx,
        { x: displayPrimary.x * displayScale, y: displayPrimary.y * displayScale },
        { x: primary.velocity.x * displayScale, y: primary.velocity.y * displayScale },
        '#FDE68A',
        4
      );
      drawArrow(
        ctx,
        { x: displayPayload.x * displayScale, y: displayPayload.y * displayScale },
        { x: payload.velocity.x * displayScale, y: payload.velocity.y * displayScale },
        '#67E8F9',
        4
      );
      drawTag(
        ctx,
        frame < 15 ? 'rocks linked · momentum transfers' : 'released · payload coasts',
        320,
        112,
        '#FDE68A'
      );
      drawTag(ctx, 'release stays controlled', 382, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeSatellitesDemo(): Demo {
  const recording = recordSatelliteDemo(FRAME_COUNT, SIM_TICKS_PER_FRAME);
  const patterns = new Set(SATELLITE_PROFILES.map((profile) => profile.shotPattern));
  invariant(recording.length === FRAME_COUNT, 'satellite recording length changed');
  invariant(recording[0]?.length === 6, 'satellite recording lost a profile');
  invariant(patterns.size === 6, 'satellite firing patterns are not all represented');
  return {
    id: 'satellites',
    posterFrame: 12,
    verify: () => {
      invariant(
        recording.every((panels) => panels.length === 6),
        'satellite recording does not keep all profiles visible'
      );
      invariant(
        recording.some((panels) => panels.some((panel) => panel.projectiles.length > 0)),
        'satellite recording contains no projectiles'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'EO SATELLITES',
        'six hulls · six firing styles',
        frame,
        PALETTE.SATELLITE
      );
      const panels: readonly SatelliteDemoPanel[] = recording[frame] ?? [];
      const displayScale = 0.3;
      for (const [index, panel] of panels.entries()) {
        const { satellite, projectiles } = panel;
        const profile = SATELLITE_PROFILES.find(
          (candidate) => candidate.typeId === satellite.typeId
        );
        if (profile === undefined) {
          continue;
        }
        const firing = projectiles.some((shot) => shot.age <= SIM_TICKS_PER_FRAME);
        const column = index % 2;
        const row = Math.floor(index / 2);
        const panelOrigin = {
          x: column === 0 ? -185 : 105,
          y: -85 + row * 80,
        };
        const position = {
          x: panelOrigin.x + satellite.position.x * displayScale,
          y: panelOrigin.y + satellite.position.y * displayScale,
        };
        const screen = screenPoint(position);
        ctx.save();
        ctx.translate(screen.x, screen.y);
        renderSatellite(ctx, satellite.typeId, 17, satellite.angle, satellite.color, firing);
        ctx.restore();
        for (const shot of projectiles) {
          const shotPosition = {
            x: panelOrigin.x + shot.position.x * displayScale,
            y: panelOrigin.y + shot.position.y * displayScale,
          };
          const shotScreen = screenPoint(shotPosition);
          const panelScreen = screenPoint(panelOrigin);
          if (
            Math.abs(shotScreen.x - panelScreen.x) > 135 ||
            Math.abs(shotScreen.y - panelScreen.y) > 34
          ) {
            continue;
          }
          drawLaser(
            ctx,
            shotPosition,
            { x: shot.velocity.x * displayScale, y: shot.velocity.y * displayScale },
            PALETTE.LASER_ENEMY
          );
        }
        ctx.save();
        ctx.fillStyle = PALETTE.HUD;
        ctx.font = '700 18px Arial';
        ctx.fillText(profile.displayName, screen.x - 55, screen.y - 22);
        ctx.restore();
      }
      drawTag(ctx, 'six firing styles', 410, 315, PALETTE.HUD_MUTED);
    },
  };
}

interface PickupView {
  typeId: 'echo' | 'relay';
  position: Position;
  angle: number;
  radius: number;
  color: string;
  state: 'loose' | 'orbiting';
}

function drawPickup(ctx: RenderContext, pickup: PickupView, scale = 1): void {
  const screen = screenPoint(pickup.position, scale);
  const radius = Math.max(6, pickup.radius * scale);
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(-pickup.angle);
  ctx.strokeStyle = pickup.color;
  ctx.shadowColor = pickup.color;
  ctx.shadowBlur = 3;
  ctx.lineWidth = 1.5;
  if (pickup.typeId === 'echo') {
    ctx.beginPath();
    ctx.roundRect(-radius * 0.65, -radius * 0.42, radius * 1.3, radius * 0.84, radius * 0.16);
    ctx.moveTo(0, -radius * 0.42);
    ctx.lineTo(0, -radius * 1.05);
    ctx.moveTo(-radius * 0.9, radius * 0.65);
    ctx.lineTo(radius * 0.9, radius * 0.65);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(radius * 0.42, -radius * 0.95, radius * 0.48, Math.PI, 0);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.rect(-radius * 0.38, -radius * 0.7, radius * 0.76, radius * 1.4);
    ctx.moveTo(-radius * 0.38, 0);
    ctx.lineTo(-radius * 1.25, -radius * 0.48);
    ctx.lineTo(-radius * 1.25, radius * 0.48);
    ctx.lineTo(-radius * 0.38, 0);
    ctx.moveTo(radius * 0.38, 0);
    ctx.lineTo(radius * 1.25, -radius * 0.48);
    ctx.lineTo(radius * 1.25, radius * 0.48);
    ctx.lineTo(radius * 0.38, 0);
    ctx.stroke();
  }
  ctx.restore();
  renderPickupDot(ctx, screen.x, screen.y);
}

function makePickupsDemo(): Demo {
  const manager = new SatellitePickupManager(new RNGService(0x7a11ce55));
  const created = manager.createPickups(2);
  const first = created[0];
  if (first === undefined) {
    throw new Error('wiki-media verification failed: pickup manager did not create Echo');
  }
  const collected = manager.collect(first.id, 'pilot', 0);
  invariant(
    collected?.state === 'orbiting' && collected.ownerId === 'pilot',
    'pickup collection did not enter orbiting state'
  );
  let sawOrbiting = false;
  return {
    id: 'pickups',
    posterFrame: 10,
    verify: () => invariant(sawOrbiting, 'pickup orbit timer did not run'),
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SATELLITE PICKUPS',
        'collect loose Echo → orbit the pilot with a short shield timer',
        frame,
        PALETTE.SATELLITE_PICKUP
      );
      runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
        manager.update([{ id: 'pilot', position: { x: 0, y: 0 }, health: 100, exploding: false }]);
        const current = manager.getPickup(first.id);
        sawOrbiting ||= current?.state === 'orbiting' && current.shieldFramesRemaining < 180;
      });
      const pickups = manager.getAllPickups();
      const firstPickup = pickups.find((pickup) => pickup.id === first.id);
      if (firstPickup) {
        if (firstPickup.state === 'orbiting') {
          drawRing(ctx, { x: 0, y: 0 }, 42, PALETTE.SATELLITE_PICKUP, 0.28);
        }
        drawPickup(ctx, firstPickup, firstPickup.state === 'orbiting' ? 1.35 : 0.7);
      }
      const loose = pickups.find((pickup) => pickup.id !== first.id);
      if (loose) {
        drawPickup(ctx, loose, 0.35);
      }
      drawShip(ctx, 'dart', { x: 0, y: 0 }, 0, PALETTE.LOCAL, getShipKit('dart').size / 2);
      drawTag(
        ctx,
        firstPickup?.state === 'orbiting'
          ? `Echo orbit · shield ${secondsLabel(firstPickup.shieldFramesRemaining)}`
          : firstPickup?.state === 'loose'
            ? 'Echo released'
            : 'Echo collected',
        340,
        112,
        PALETTE.SATELLITE_PICKUP
      );
      drawTag(ctx, 'collect Echo · gain a short shield', 320, 286, PALETTE.HUD_MUTED);
    },
  };
}

function buildDemos(): Demo[] {
  return [
    makeDartDemo(),
    makeHaulerDemo(),
    makeWardenDemo(),
    makeSkirmisherDemo(),
    makeQuakeDemo(),
    makeMovementDemo(),
    makeTerrainDemo(),
    makeLootDemo(),
    makeReflectionDemo(),
    makeShieldDemo(),
    makeSplitDemo(),
    makeSlingshotDemo(),
    makeWinchDemo(),
    makeSatellitesDemo(),
    makePickupsDemo(),
  ];
}

function verifyCoverage(): void {
  const metadataIds = Object.keys(media).sort();
  const expectedIds = [...MEDIA_IDS].sort();
  invariant(
    JSON.stringify(metadataIds) === JSON.stringify(expectedIds),
    'media metadata IDs do not match generator IDs'
  );
  for (const id of MEDIA_IDS) {
    const entry = media[id];
    if (entry === undefined) {
      throw new Error(`wiki-media verification failed: missing metadata for ${id}`);
    }
    for (const source of entry.sources) {
      invariant(existsSync(resolve(source)), `missing cited source ${source}`);
    }
  }
}

function renderRun(root: string): RenderedRun {
  const demos = buildDemos();
  const frameHashes: Partial<Record<MediaId, string[]>> = {};
  for (const demo of demos) {
    const directory = join(root, demo.id);
    mkdirSync(directory, { recursive: true });
    const hashes: string[] = [];
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const canvas = createCanvas(WIDTH, HEIGHT);
      const ctx = canvas.getContext('2d');
      demo.render(ctx, frame);
      const png = canvas.toBuffer('image/png');
      const path = join(directory, `frame-${String(frame).padStart(2, '0')}.png`);
      writeFileSync(path, png);
      hashes.push(sha256(png));
    }
    demo.verify();
    frameHashes[demo.id] = hashes;
  }
  return { root, frameHashes };
}

function encodeGif(python: string, frames: string, output: string): void {
  const result = spawnSync(python, [ENCODER_SCRIPT, frames, output, '--fps', String(FPS)], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${ENCODER_SCRIPT} failed (${result.status}): ${result.stderr}`);
  }
}

function parseArgs(): { output: string; python: string; verifyOnly: boolean } {
  let output = resolve('public/wiki/media');
  let python = process.env['WIKI_MEDIA_PYTHON'] ?? 'python3';
  let verifyOnly = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--output needs a directory');
      }
      output = resolve(value);
      index += 1;
    } else if (arg === '--python') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--python needs an executable path');
      }
      python = value;
      index += 1;
    } else if (arg === '--verify') {
      verifyOnly = true;
    } else {
      throw new Error(`Unknown wiki-media option: ${arg}`);
    }
  }
  return { output, python, verifyOnly };
}

function cleanOutput(output: string): void {
  mkdirSync(output, { recursive: true });
  for (const name of readdirSync(output)) {
    if (name.endsWith('.gif') || name.endsWith('.png') || name === 'manifest.json') {
      rmSync(join(output, name), { force: true });
    }
  }
}

function verifyExistingOutput(output: string, expectedManifest: MediaManifest): void {
  invariant(existsSync(output), `missing media output directory ${output}`);
  const expected = new Set<string>(['manifest.json']);
  for (const id of MEDIA_IDS) {
    expected.add(`${id}.gif`);
    expected.add(`${id}.png`);
  }
  for (const name of expected) {
    invariant(existsSync(join(output, name)), `missing generated asset ${join(output, name)}`);
  }
  for (const name of readdirSync(output)) {
    if (
      (name.endsWith('.gif') || name.endsWith('.png') || name === 'manifest.json') &&
      !expected.has(name)
    ) {
      throw new Error(`wiki-media verification failed: stale asset ${join(output, name)}`);
    }
  }
  let actualManifest: MediaManifest;
  try {
    actualManifest = JSON.parse(
      readFileSync(join(output, 'manifest.json'), 'utf8')
    ) as MediaManifest;
  } catch (error) {
    throw new Error(`wiki-media verification failed: unreadable manifest (${String(error)})`);
  }
  invariant(
    actualManifest.version === expectedManifest.version &&
      actualManifest.seed === expectedManifest.seed &&
      actualManifest.simulationFps === expectedManifest.simulationFps &&
      actualManifest.ticksPerFrame === expectedManifest.ticksPerFrame &&
      actualManifest.width === expectedManifest.width &&
      actualManifest.height === expectedManifest.height &&
      actualManifest.fps === expectedManifest.fps &&
      actualManifest.frameCount === expectedManifest.frameCount &&
      actualManifest.encoder === expectedManifest.encoder,
    'existing manifest metadata is stale'
  );
  for (const id of MEDIA_IDS) {
    const expectedAsset = expectedManifest.assets[id];
    const actualAsset = actualManifest.assets[id];
    if (expectedAsset === undefined || actualAsset === undefined) {
      throw new Error(`wiki-media verification failed: missing manifest asset ${id}`);
    }
    invariant(
      JSON.stringify(actualAsset) === JSON.stringify(expectedAsset),
      `existing manifest asset is stale for ${id}`
    );
    invariant(
      sha256(readFileSync(join(output, `${id}.gif`))) === expectedAsset.gifSha256,
      `existing GIF bytes are stale for ${id}`
    );
    invariant(
      sha256(readFileSync(join(output, `${id}.png`))) === expectedAsset.posterSha256,
      `existing poster bytes are stale for ${id}`
    );
  }
}

function main(): void {
  verifyCoverage();
  const { output, python, verifyOnly } = parseArgs();
  invariant(existsSync(ENCODER_SCRIPT), `missing encoder ${ENCODER_SCRIPT}`);
  const tempRoot = mkdtempSync(join(tmpdir(), 'georoids-wiki-media-'));
  const runA = renderRun(join(tempRoot, 'run-a'));
  const runB = renderRun(join(tempRoot, 'run-b'));
  const gifsA = join(tempRoot, 'gifs-a');
  const gifsB = join(tempRoot, 'gifs-b');
  mkdirSync(gifsA, { recursive: true });
  mkdirSync(gifsB, { recursive: true });
  const assetManifests: Partial<Record<MediaId, AssetManifest>> = {};
  const demos = buildDemos();

  for (const id of MEDIA_IDS) {
    const framesA = runA.frameHashes[id];
    const framesB = runB.frameHashes[id];
    if (framesA === undefined || framesB === undefined) {
      throw new Error(`wiki-media verification failed: missing frame hashes for ${id}`);
    }
    invariant(
      JSON.stringify(framesA) === JSON.stringify(framesB),
      `${id} frames are not reproducible`
    );
    const gifA = join(gifsA, `${id}.gif`);
    const gifB = join(gifsB, `${id}.gif`);
    encodeGif(python, join(runA.root, id), gifA);
    encodeGif(python, join(runB.root, id), gifB);
    const gifBytesA = readFileSync(gifA);
    const gifBytesB = readFileSync(gifB);
    invariant(sha256(gifBytesA) === sha256(gifBytesB), `${id} GIF encoding is not reproducible`);
    const demo = demos.find((candidate) => candidate.id === id);
    if (demo === undefined) {
      throw new Error(`wiki-media verification failed: missing demo for ${id}`);
    }
    const posterPath = join(
      runA.root,
      demo.id,
      `frame-${String(demo.posterFrame).padStart(2, '0')}.png`
    );
    const posterBytes = readFileSync(posterPath);
    assetManifests[id] = {
      frameHashes: framesA,
      gifSha256: sha256(gifBytesA),
      posterSha256: sha256(posterBytes),
    };
  }

  const manifest: MediaManifest = {
    version: 1,
    seed: SEED,
    simulationFps: GAME.FPS,
    ticksPerFrame: SIM_TICKS_PER_FRAME,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    frameCount: FRAME_COUNT,
    encoder: ENCODER_VERSION,
    assets: assetManifests,
  };
  if (verifyOnly) {
    verifyExistingOutput(output, manifest);
  } else {
    cleanOutput(output);
    for (const demo of demos) {
      const gif = join(gifsA, `${demo.id}.gif`);
      const posterPath = join(
        runA.root,
        demo.id,
        `frame-${String(demo.posterFrame).padStart(2, '0')}.png`
      );
      const gifBytes = readFileSync(gif);
      const posterBytes = readFileSync(posterPath);
      writeFileSync(join(output, `${demo.id}.gif`), gifBytes);
      writeFileSync(join(output, `${demo.id}.png`), posterBytes);
    }
    writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  rmSync(tempRoot, { recursive: true, force: true });
  process.stdout.write(
    `${verifyOnly ? 'wiki media verified' : 'wiki media generated'}: ${MEDIA_IDS.length} GIFs + ${MEDIA_IDS.length} posters\n`
  );
  process.stdout.write(`output: ${output}\n`);
  process.stdout.write(
    `seed: ${SEED} · ${WIDTH}x${HEIGHT} · ${FRAME_COUNT} frames · ${FPS} fps · ${GAME.FPS} Hz simulation · ${SIM_TICKS_PER_FRAME} ticks/frame\n`
  );
  process.stdout.write(`encoder: ${ENCODER_VERSION}\n`);
}

main();
