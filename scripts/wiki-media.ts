import { FACTION_COLORS } from '../shared/factions';
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
  ASTEROID_INTERACTIONS,
  previewChargedReflections,
  segmentCircleContact,
} from '../shared/asteroidPhenomena';
import { asteroidRamDamage, circlesOverlap } from '../shared/combat';
import { SATELLITE_PROFILES } from '../shared/eoSatellites';
import {
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
  LOOT_BLAST,
} from '../shared/lootBlast';
import { findNearestShieldImpact, reflectProjectileVelocity } from '../shared/shieldReflection';
import {
  applyLootMass,
  lootOverlap,
  radiusFromMass,
  sizeScaleFromMass,
} from '../shared/shipGrowth';
import type { AsteroidData, Position, Velocity } from '../shared-types';
import {
  DAMAGE,
  FUEL,
  GAME,
  PALETTE,
  SATELLITE_PICKUP,
  SHIELD,
  SHIP,
  TITLE,
  VISUAL,
} from '../src/constants';
import { lootScreenRadius, lootStrokeColor } from '../src/entities/loot/lootRenderer';
import { drawAsteroidMaterialDetails } from '../src/entities/roid/materialArt';
import { drawRoidInteractionCues } from '../src/entities/roid/roidRenderer';
import { drawEoSatelliteOutline } from '../src/entities/satellite/eoOutlines';
import { getKitHullOutline, projectHullPoint } from '../src/entities/ship/hullOutlines';
import { applyQuakeImpulse } from '../src/entities/ship/quakeImpulse';
import { paintQuakePulse } from '../src/entities/ship/quakePulseRenderer';
import {
  type AbilityBody,
  type AbilityHost,
  type AbilityWorld,
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
import {
  createSkirmisherRingShots,
  SKIRMISHER_RING_COUNT,
} from '../src/entities/ship/skirmisherRing';
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
  roid: Pick<AsteroidData, 'phenomenon'>,
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
  color: string = FACTION_COLORS.ion,
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
  const cues: Pick<AsteroidData, 'phenomenon'> = {};
  if (rock.phenomenon !== undefined) {
    cues.phenomenon = rock.phenomenon;
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
    posterFrame: 1,
    verify: () => {
      invariant(activeFrames[0] === 12, 'Dart active window changed');
      invariant(
        positions.some((position, index) => position.x > start.x && (index ?? 0) > 0),
        'Dart did not advance after the boost'
      );
      invariant((speeds.at(-1) ?? 0) < (speeds[0] ?? 0), 'Dart drift did not slow under friction');
    },
    render: (ctx, frame) => {
      drawFrameChrome(ctx, 'DART · BOOST DASH', 'E trigger → burst → coast', frame);
      const displayScale = 0.5;
      const position = positions[frame] ?? positions[0] ?? start;
      const pathStart = screenPoint(positions[Math.max(0, frame - 8)] ?? start, displayScale);
      const pathEnd = screenPoint(position, displayScale);
      renderSegment(ctx, pathStart.x, pathStart.y, pathEnd.x, pathEnd.y, FACTION_COLORS.ion, 1, 2);
      drawShip(
        ctx,
        'dart',
        { x: position.x * displayScale, y: position.y * displayScale },
        0,
        FACTION_COLORS.ion,
        getShipKit('dart').size / 2,
        (activeFrames[frame] ?? 0) > 0
      );
      drawTag(
        ctx,
        (activeFrames[frame] ?? 0) > 0 ? 'E · boost active' : 'dash complete · coast',
        380,
        112,
        FACTION_COLORS.ion
      );
      drawTag(ctx, `speed ${speeds[frame]?.toFixed(2) ?? '0.00'}`, 440, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeHaulerDemo(): Demo {
  const host = makeAbilityHost('hauler', { x: 120, y: 16 });
  const target: AbilityBody = {
    id: 'demo-rock',
    kind: 'asteroid',
    position: { x: -100, y: 16 },
    velocity: { x: 0, y: 0 },
    size: 34,
  };
  const victim: AbilityBody = {
    id: 'demo-victim',
    kind: 'ship',
    position: { x: -300, y: 16 },
    velocity: { x: 0, y: 0 },
    health: 100,
    r: getShipKit('dart').size / 2,
  };
  const world: AbilityWorld = {
    asteroids: [target],
    entities: [victim],
    canvas: { width: WIDTH, height: HEIGHT },
    playfieldScale: 1,
  };
  const bodies = [...world.asteroids, ...world.entities];
  const result = activateAbilityOnHost(host, world);
  invariant(
    result.activated && result.abilityId === 'harpoon',
    'Hauler E did not latch a nearby rock'
  );
  invariant(host.harpoonTargetId === target.id, 'Hauler selected the wrong target');
  let reelTicks = 0;
  let sawRightwardReel = false;
  let releasedFrame: number | undefined;
  let releaseGap: number | undefined;
  let sawLeftwardRelease = false;
  let targetRotation = 0;
  const targetAngularVelocity = 0.14;
  let targetDestroyed = false;
  let impactFrame: number | undefined;
  return {
    id: 'hauler',
    posterFrame: 4,
    verify: () => {
      invariant(reelTicks > 0, 'Hauler rock did not reel toward its owner');
      invariant(sawRightwardReel, 'Hauler rock did not show the rightward reel');
      invariant(releasedFrame !== undefined, 'Hauler rock did not release near the hull');
      invariant(sawLeftwardRelease, 'Hauler rock did not reverse toward the predicted enemy');
      invariant(
        releaseGap !== undefined &&
          releaseGap <=
            (host.r ?? 20) + (target.r ?? target.size ?? 20) + SHIP_ABILITY.HARPOON_RELEASE_GAP + 1,
        'Hauler rock released outside the hull safety gap'
      );
      invariant(
        impactFrame !== undefined && targetDestroyed,
        'released rock did not hit the second ship'
      );
      invariant(
        victim.health === 100 - asteroidRamDamage(),
        'rock impact did not apply collision damage'
      );
      invariant(Math.abs(targetRotation) > 1, 'rock did not visibly spin after launch');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'HAULER · HARPOON',
        'E trigger → reel toward hull → release → impact',
        frame,
        '#FDE68A'
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          const activeBeforeTick = host.harpoonTimer > 0;
          if (activeBeforeTick) {
            pullHarpoonTarget(host, bodies);
            const gap = Math.hypot(
              target.position.x - host.position.x,
              target.position.y - host.position.y
            );
            const releaseRadius =
              (host.r ?? 20) + (target.r ?? target.size ?? 20) + SHIP_ABILITY.HARPOON_RELEASE_GAP;
            if (target.velocity.x > 0 && releasedFrame === undefined) {
              sawRightwardReel = true;
            }
            if (
              releasedFrame === undefined &&
              gap <= releaseRadius + 1 &&
              Math.hypot(target.velocity.x, target.velocity.y) >=
                SHIP_ABILITY.HARPOON_SLING_SPEED - 0.01
            ) {
              releasedFrame = frame;
              releaseGap = gap;
              sawLeftwardRelease = target.velocity.x < 0;
            }
          }
          target.position.x += target.velocity.x;
          target.position.y += target.velocity.y;
          targetRotation += targetAngularVelocity;
          if (activeBeforeTick && releasedFrame === undefined) {
            reelTicks += 1;
          }
          if (
            !targetDestroyed &&
            circlesOverlap(target.position, target.size ?? 0, victim.position, victim.r ?? 0)
          ) {
            targetDestroyed = true;
            impactFrame = frame;
            victim.health = Math.max(0, (victim.health ?? 0) - asteroidRamDamage());
          }
          tickAbilityHost(host);
        });
      }
      const displayScale = 0.62;
      const displayHost = {
        x: host.position.x * displayScale,
        y: host.position.y * displayScale,
      };
      const displayTarget = {
        x: target.position.x * displayScale,
        y: target.position.y * displayScale,
      };
      const displayVictim = {
        x: victim.position.x * displayScale,
        y: victim.position.y * displayScale,
      };
      if (!targetDestroyed) {
        drawRoid(
          ctx,
          {
            position: target.position,
            size: target.size ?? 34,
            rotation: targetRotation,
            vertices: 8,
            offsets: [1, 0.8, 1.05, 0.92, 1, 0.78, 1.04, 0.88],
            material: 'metal',
            health: 75,
            maxHealth: 75,
          },
          displayScale
        );
      }
      if (host.harpoonTimer > 0 && !targetDestroyed) {
        drawCable(ctx, displayHost, displayTarget);
      }
      drawShip(
        ctx,
        'hauler',
        displayHost,
        0,
        FACTION_COLORS.ion,
        (getShipKit('hauler').size / 2) * displayScale
      );
      drawShip(
        ctx,
        'dart',
        displayVictim,
        Math.PI,
        FACTION_COLORS.ember,
        (victim.r ?? 0) * displayScale
      );
      if (releasedFrame === undefined && host.harpoonTimer > 0) {
        drawRing(
          ctx,
          displayHost,
          ((host.r ?? 20) + (target.r ?? target.size ?? 20) + SHIP_ABILITY.HARPOON_RELEASE_GAP) *
            displayScale,
          PALETTE.SHIELD,
          0.5
        );
      }
      if (impactFrame !== undefined && frame >= impactFrame && frame < impactFrame + 8) {
        const impactAge = frame - impactFrame;
        drawRing(
          ctx,
          displayVictim,
          18 + impactAge * 8,
          PALETTE.DANGER,
          Math.max(0.12, 0.9 - impactAge * 0.1)
        );
      }
      drawTag(
        ctx,
        targetDestroyed
          ? 'impact · target ship loses 25 hull'
          : releasedFrame !== undefined
            ? 'released at hull safety gap · bounce left'
            : host.harpoonTimer > 0
              ? 'cable active · reeling toward Hauler'
              : 'timer ended · rock coasts',
        310,
        110,
        '#FDE68A'
      );
      drawTag(ctx, 'E · reel right → bounce left → impact', 400, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeWardenDemo(): Demo {
  const host = makeAbilityHost('warden', { x: -90, y: 18 });
  host.factionId = 'ion';
  const friendly: AbilityBody & { shieldTimer: number } = {
    id: 'warden-demo-friendly',
    kind: 'ship',
    factionId: 'ion',
    position: { x: 40, y: 18 },
    velocity: { x: 0, y: 0 },
    health: 100,
    r: getShipKit('dart').size / 2,
    shieldTimer: 0,
  };
  const attacker: AbilityBody = {
    id: 'warden-demo-attacker',
    kind: 'ship',
    factionId: 'ember',
    position: { x: 170, y: 18 },
    velocity: { x: 0, y: 0 },
    health: 100,
    r: getShipKit('dart').size / 2,
  };
  const world: AbilityWorld = {
    asteroids: [],
    entities: [friendly, attacker],
    canvas: { width: WIDTH, height: HEIGHT },
    playfieldScale: 1,
  };
  const result = activateAbilityOnHost(host, world);
  invariant(
    result.activated && result.abilityId === 'shieldFocus',
    'Warden E did not activate shieldFocus'
  );
  invariant(host.shieldTargetId === friendly.id, 'Warden E did not project to a nearby ally');
  invariant(
    friendly.shieldTimer === SHIP_ABILITY.SHIELD_PROJECTION_FRAMES,
    'projected shield timer changed'
  );
  const shieldImpact = findNearestShieldImpact(
    attacker.position,
    friendly.position,
    [
      {
        id: 'warden-demo-friendly',
        position: friendly.position,
        radius: (friendly.r ?? 0) * SHIELD.RADIUS_RATIO,
      },
    ],
    attacker.id ?? 'warden-demo-attacker'
  );
  if (shieldImpact === null) {
    throw new Error(
      'wiki-media verification failed: projected shield did not intercept the incoming laser'
    );
  }
  const incomingVelocity = { x: -10, y: 0 };
  const reflectedVelocity = reflectProjectileVelocity(incomingVelocity, shieldImpact.normal);
  invariant(
    reflectedVelocity.x > 0,
    'projected shield did not reflect the laser toward its shooter'
  );
  let sawExpired = false;
  let reflectedShot = false;
  let attackerHit = false;
  const contactFrame = 12;
  const attackerHitFrame =
    contactFrame +
    Math.ceil(Math.abs(attacker.position.x - shieldImpact.point.x) / Math.abs(reflectedVelocity.x));
  return {
    id: 'warden',
    posterFrame: 12,
    verify: () => {
      invariant(
        sawExpired,
        'projected Warden shield timer did not expire after the shown duration'
      );
      invariant(reflectedShot, 'projected Warden shield did not reflect the incoming laser');
      invariant(attackerHit, 'reflected Warden laser did not reach its shooter');
      invariant(friendly.health === 100, 'projected shielded ally took reflected-laser damage');
      invariant(
        attacker.health === 100 - DAMAGE.LASER_HIT,
        'reflected laser did not damage its shooter'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'WARDEN · SHIELD PROJECTION',
        'E trigger → nearest ally shield → reflected shot',
        frame,
        PALETTE.SHIELD
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          tickAbilityHost(host);
          if (friendly.shieldTimer > 0) {
            friendly.shieldTimer -= 1;
            if (friendly.shieldTimer <= 0) {
              delete friendly.shieldSourceId;
            }
          }
          sawExpired ||= friendly.shieldTimer <= 0;
        });
      }
      if (frame >= contactFrame) {
        reflectedShot = true;
      }
      if (frame >= attackerHitFrame) {
        attackerHit = true;
        attacker.health = 100 - DAMAGE.LASER_HIT;
      }
      const shieldUp = friendly.shieldTimer > 0;
      if (host.abilityActiveFrames > 0 && shieldUp) {
        drawCable(ctx, host.position, friendly.position, PALETTE.SHIELD);
      }
      if (shieldUp) {
        drawRing(
          ctx,
          friendly.position,
          (friendly.r ?? 0) * SHIELD.RADIUS_RATIO,
          PALETTE.SHIELD,
          0.92
        );
      }
      drawShip(ctx, 'warden', host.position, 0, FACTION_COLORS.ion, getShipKit('warden').size / 2);
      drawShip(ctx, 'dart', friendly.position, 0, FACTION_COLORS.ion, friendly.r ?? 0);
      drawShip(ctx, 'dart', attacker.position, Math.PI, FACTION_COLORS.ember, attacker.r ?? 0);
      if (frame <= contactFrame) {
        const contactProgress = Math.min(1, frame / contactFrame);
        const laser = {
          x: attacker.position.x + (shieldImpact.point.x - attacker.position.x) * contactProgress,
          y: attacker.position.y,
        };
        drawLaser(ctx, laser, incomingVelocity, PALETTE.LASER_ENEMY);
      } else if (!attackerHit) {
        const reflectedProgress = frame - contactFrame;
        const laser = {
          x: shieldImpact.point.x + reflectedVelocity.x * reflectedProgress,
          y: shieldImpact.point.y + reflectedVelocity.y * reflectedProgress,
        };
        drawLaser(ctx, laser, reflectedVelocity, PALETTE.LASER_LOCAL);
      }
      if (frame === contactFrame) {
        drawRing(
          ctx,
          friendly.position,
          (friendly.r ?? 0) * SHIELD.RADIUS_RATIO + 10,
          PALETTE.SHIELD,
          0.9
        );
      }
      if (frame >= attackerHitFrame && frame < attackerHitFrame + 6) {
        drawRing(ctx, attacker.position, (attacker.r ?? 0) + 15, PALETTE.LASER_LOCAL, 0.9);
      }
      drawTag(
        ctx,
        shieldUp ? `ally shield · ${secondsLabel(friendly.shieldTimer)}` : 'ally shield expired',
        350,
        112,
        PALETTE.SHIELD
      );
      drawTag(
        ctx,
        frame < contactFrame
          ? 'hostile laser approaching ally'
          : attackerHit
            ? 'reflected laser · shooter hit'
            : 'shield contact · laser reflected',
        340,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makeSkirmisherDemo(): Demo {
  const host = makeAbilityHost('skirmisher', { x: -140, y: 42 }, 0);
  const target: AbilityBody = {
    id: 'skirmisher-demo-target',
    kind: 'ship',
    factionId: 'ember',
    position: { x: 0, y: 42 },
    velocity: { x: 0, y: 0 },
    health: 100,
    r: getShipKit('dart').size / 2,
  };
  const result = activateAbilityOnHost(host);
  invariant(
    result.activated && result.abilityId === 'ringFire',
    'Skirmisher E did not activate ringFire'
  );
  const kit = getShipKit('skirmisher');
  const shots = createSkirmisherRingShots(host.position, host.angle, kit.size / 2, host.velocity);
  invariant(shots.length === SKIRMISHER_RING_COUNT, 'Skirmisher ring count changed');
  let targetHit = false;
  let targetHitFrame: number | undefined;
  return {
    id: 'skirmisher',
    posterFrame: 8,
    verify: () => {
      invariant(host.abilityActiveFrames === 8, 'Skirmisher active window changed');
      invariant(targetHit, 'Skirmisher ring did not hit the demonstration target');
      invariant(
        target.health === 100 - DAMAGE.LASER_HIT,
        'Skirmisher target took the wrong hit damage'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SKIRMISHER · RING FIRE',
        'E trigger → outward laser ring → target hit',
        frame,
        PALETTE.LASER_LOCAL
      );
      drawShip(
        ctx,
        'skirmisher',
        host.position,
        host.angle,
        FACTION_COLORS.ion,
        getShipKit('skirmisher').size / 2
      );
      for (const shot of shots) {
        const position = {
          x: shot.position.x + shot.velocity.x * frame * 2.1,
          y: shot.position.y + shot.velocity.y * frame * 2.1,
        };
        if (!targetHit && circlesOverlap(position, 4, target.position, target.r ?? 0)) {
          targetHit = true;
          targetHitFrame = frame;
          target.health = Math.max(0, (target.health ?? 0) - DAMAGE.LASER_HIT);
        }
        drawLaser(ctx, position, shot.velocity);
      }
      drawShip(ctx, 'dart', target.position, Math.PI, FACTION_COLORS.ember, target.r ?? 0);
      if (targetHitFrame !== undefined && frame < targetHitFrame + 7) {
        drawRing(ctx, target.position, (target.r ?? 0) + 16, PALETTE.LASER_LOCAL, 0.9);
      }
      drawTag(
        ctx,
        targetHit
          ? `target hit · ${target.health} hull`
          : `${SKIRMISHER_RING_COUNT} lasers · full ring`,
        340,
        112,
        PALETTE.LASER_LOCAL
      );
      drawTag(
        ctx,
        targetHit ? 'ring reaches the target hull' : 'lasers fan out in every direction',
        394,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makeQuakeDemo(): Demo {
  const host = makeAbilityHost('quake', { x: 0, y: 0 });
  const target: AbilityBody = {
    id: 'quake-demo-target',
    kind: 'ship',
    factionId: 'ember',
    position: { x: 120, y: 0 },
    velocity: { x: 0, y: 0 },
    health: 100,
    r: getShipKit('dart').size / 2,
  };
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
  const loot: AbilityBody = {
    id: 'quake-loot',
    position: { x: -150, y: 26 },
    velocity: { x: -0.2, y: 0.15 },
    r: 8,
  };
  const satellite: AbilityBody & {
    angle: number;
    color: string;
    radius: number;
  } = {
    id: 'quake-satellite',
    position: { x: 160, y: -58 },
    velocity: { x: 0.1, y: 0.15 },
    angle: 0.2,
    color: PALETTE.SATELLITE,
    radius: 15,
  };
  const pickup: AbilityBody & {
    angle: number;
    color: string;
    health: number;
    radius: number;
    typeId: 'echo';
    state: 'loose';
    maxHealth: number;
  } = {
    id: 'quake-pickup',
    position: { x: -164, y: -54 },
    velocity: { x: -0.1, y: -0.18 },
    angle: 0,
    color: PALETTE.SATELLITE_PICKUP,
    radius: 10,
    typeId: 'echo',
    state: 'loose',
    health: 100,
    maxHealth: 100,
  };
  const shot: AbilityBody = {
    id: 'quake-shot',
    position: { x: 102, y: 94 },
    velocity: { x: -2.5, y: 0.5 },
  };
  const world: AbilityWorld = {
    asteroids: rocks,
    entities: [target],
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
  const extraBodies = [loot, satellite, pickup, shot];
  for (const body of extraBodies) {
    invariant(applyQuakeImpulse(body, host.position, host.angle), 'Quake missed a nearby object');
  }
  const physicalBodies = [...rocks, target, ...extraBodies];
  const startingPositions = physicalBodies.map((body) => ({ ...body.position }));
  const targetStart = copyPosition(target.position);
  let targetPushed = false;
  let targetHitFrame: number | undefined;
  return {
    id: 'quake',
    posterFrame: 3,
    verify: () => {
      invariant(
        physicalBodies.some(
          (body, index) =>
            Math.hypot(
              body.position.x - (startingPositions[index]?.x ?? 0),
              body.position.y - (startingPositions[index]?.y ?? 0)
            ) > 0
        ),
        'Quake objects did not move after the pulse'
      );
      invariant(
        targetPushed && target.position.x > targetStart.x,
        'Quake pulse did not push the demonstration ship'
      );
      invariant(
        extraBodies.every((body) => Math.hypot(body.velocity.x, body.velocity.y) > 0),
        'Quake did not push every physical object in the demonstration'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'QUAKE · SHOCK PULSE',
        'E trigger → blue pulse → nearby objects pushed',
        frame,
        '#60A5FA'
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          // Keep the whole object set in the readable frame while retaining the
          // direction and relative strength produced by the real impulse helper.
          for (const body of physicalBodies) {
            body.position.x += body.velocity.x * 0.04;
            body.position.y += body.velocity.y * 0.04;
          }
          tickAbilityHost(host);
        });
      }
      const displayScale = 0.32;
      const pulseProgress = Math.min(0.999, (frame * 1000) / FPS / 650);
      const pulseRadius = SHIP_ABILITY.SHOCK_RADIUS * (1 - (1 - pulseProgress) ** 2);
      if (!targetPushed && pulseRadius >= Math.hypot(targetStart.x, targetStart.y)) {
        targetPushed = true;
        targetHitFrame = frame;
      }
      if (pulseProgress < 1) {
        paintQuakePulse(
          ctx,
          screenPoint(host.position),
          SHIP_ABILITY.SHOCK_RADIUS * displayScale,
          pulseProgress
        );
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
          displayScale
        );
        drawArrow(
          ctx,
          { x: rock.position.x * displayScale, y: rock.position.y * displayScale },
          { x: rock.velocity.x * displayScale, y: rock.velocity.y * displayScale },
          '#60A5FA',
          5
        );
      }
      drawLootDiamond(ctx, loot.position, loot.r ?? 8, PALETTE.LOOT, 1, displayScale);
      drawArrow(
        ctx,
        { x: loot.position.x * displayScale, y: loot.position.y * displayScale },
        { x: loot.velocity.x * displayScale, y: loot.velocity.y * displayScale },
        PALETTE.LOOT,
        2
      );
      const satelliteScreen = screenPoint(satellite.position, displayScale);
      ctx.save();
      ctx.translate(satelliteScreen.x, satelliteScreen.y);
      renderSatellite(
        ctx,
        'aqua',
        satellite.radius * displayScale,
        satellite.angle,
        satellite.color,
        false
      );
      ctx.restore();
      drawArrow(
        ctx,
        { x: satellite.position.x * displayScale, y: satellite.position.y * displayScale },
        { x: satellite.velocity.x * displayScale, y: satellite.velocity.y * displayScale },
        PALETTE.SATELLITE,
        2
      );
      drawPickup(ctx, pickup, displayScale);
      drawArrow(
        ctx,
        { x: pickup.position.x * displayScale, y: pickup.position.y * displayScale },
        { x: pickup.velocity.x * displayScale, y: pickup.velocity.y * displayScale },
        PALETTE.SATELLITE_PICKUP,
        2
      );
      drawLaser(
        ctx,
        { x: shot.position.x * displayScale, y: shot.position.y * displayScale },
        { x: shot.velocity.x * displayScale, y: shot.velocity.y * displayScale },
        PALETTE.LASER_ENEMY
      );
      drawShip(
        ctx,
        'dart',
        { x: target.position.x * displayScale, y: target.position.y * displayScale },
        Math.PI,
        FACTION_COLORS.ember,
        (target.r ?? 0) * displayScale
      );
      if (targetHitFrame !== undefined && frame >= targetHitFrame && frame < targetHitFrame + 8) {
        drawRing(
          ctx,
          { x: target.position.x * displayScale, y: target.position.y * displayScale },
          (target.r ?? 0) * displayScale + 14,
          '#60A5FA',
          0.9
        );
      }
      drawShip(ctx, 'quake', host.position, 0, FACTION_COLORS.ion, getShipKit('quake').size / 2);
      drawTag(ctx, `EMP · fuel ${host.fuel}/${host.maxFuel}`, 350, 112, '#60A5FA');
      drawTag(
        ctx,
        targetPushed
          ? 'pulse reached target · nearby objects pushed'
          : 'blue pulse expanding · physical objects pushed',
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
        FACTION_COLORS.ion
      );
      const position = positions[frame + 1] ?? positions[0] ?? { x: 0, y: 0 };
      const trailStart = positions[Math.max(0, frame - 9)] ?? position;
      const displayScale = 0.4;
      const a = screenPoint(trailStart, displayScale);
      const b = screenPoint(position, displayScale);
      renderSegment(ctx, a.x, a.y, b.x, b.y, FACTION_COLORS.ion, 1, 2);
      drawShip(
        ctx,
        'dart',
        { x: position.x * displayScale, y: position.y * displayScale },
        0,
        FACTION_COLORS.ion,
        getShipKit('dart').size / 2,
        frame < 12
      );
      drawTag(
        ctx,
        frame < 12 ? 'ArrowUp held · thrust' : 'released · friction',
        350,
        112,
        FACTION_COLORS.ion
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
      drawShip(
        ctx,
        'dart',
        { x: 0, y: 0 },
        0,
        FACTION_COLORS.ion,
        getShipKit('dart').size / 2,
        false
      );
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
        FACTION_COLORS.ion,
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
  const warden = makeAbilityHost('warden', { x: -150, y: -72 });
  warden.factionId = 'ion';
  const projected: AbilityBody & { shieldTimer: number } = {
    id: 'shield-demo-projected',
    kind: 'ship',
    factionId: 'ion',
    position: { x: -20, y: -72 },
    velocity: { x: 0, y: 0 },
    health: 100,
    r: getShipKit('dart').size / 2,
    shieldTimer: 0,
  };
  const world: AbilityWorld = {
    asteroids: [],
    entities: [projected],
    canvas: { width: WIDTH, height: HEIGHT },
    playfieldScale: 1,
  };
  const wardenResult = activateAbilityOnHost(warden, world);
  const regular = createShieldState();
  invariant(
    wardenResult.activated && wardenResult.abilityId === 'shieldFocus',
    'shield comparison Warden projection did not activate'
  );
  invariant(
    projected.shieldTimer === SHIP_ABILITY.SHIELD_PROJECTION_FRAMES,
    'shield comparison projection duration changed'
  );
  invariant(
    activateShield(regular, false, 'warden'),
    'shield comparison Warden F lane did not activate'
  );
  invariant(isShieldBlockingLasers(regular), 'regular F shield is not laser blocking');
  const regularPosition = { x: -20, y: 72 };
  const projectedAttacker = { x: 190, y: -72 };
  const regularAttacker = { x: 190, y: 72 };
  const projectedImpact = findNearestShieldImpact(
    projectedAttacker,
    projected.position,
    [
      {
        id: projected.id ?? 'projected',
        position: projected.position,
        radius: (projected.r ?? 0) * SHIELD.RADIUS_RATIO,
      },
    ],
    'projected-attacker'
  );
  const regularImpact = findNearestShieldImpact(
    regularAttacker,
    regularPosition,
    [
      {
        id: 'regular-f-shield',
        position: regularPosition,
        radius: (getShipKit('dart').size / 2) * SHIELD.RADIUS_RATIO,
      },
    ],
    'regular-attacker'
  );
  invariant(projectedImpact !== null, 'projected shield comparison did not intercept a laser');
  invariant(regularImpact !== null, 'regular F shield comparison did not intercept a laser');
  if (projectedImpact === null || regularImpact === null) {
    throw new Error('wiki-media verification failed: shield comparison impact was not found');
  }
  const incomingVelocity = { x: -10, y: 0 };
  const projectedVelocity = reflectProjectileVelocity(incomingVelocity, projectedImpact.normal);
  const regularVelocity = reflectProjectileVelocity(incomingVelocity, regularImpact.normal);
  invariant(
    projectedVelocity.x > 0 && regularVelocity.x > 0,
    'shield comparison did not reflect lasers'
  );
  const contactFrame = 10;
  const projectedHitFrame =
    contactFrame +
    Math.ceil(
      Math.abs(projectedAttacker.x - projectedImpact.point.x) / Math.abs(projectedVelocity.x)
    );
  const regularHitFrame =
    contactFrame +
    Math.ceil(Math.abs(regularAttacker.x - regularImpact.point.x) / Math.abs(regularVelocity.x));
  let wardenExpired = false;
  let regularExpired = false;
  let projectedReflected = false;
  let regularReflected = false;
  return {
    id: 'shield',
    posterFrame: 8,
    verify: () => {
      invariant(
        wardenExpired && regularExpired,
        'shield lanes did not show their full timed windows'
      );
      invariant(
        projectedReflected && regularReflected,
        'shield lanes did not reflect incoming lasers'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SHIELDS · E PROJECTION vs F',
        'nearby ally projection · own shield · both reflect lasers',
        frame,
        PALETTE.SHIELD
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          tickAbilityHost(warden);
          if (projected.shieldTimer > 0) {
            projected.shieldTimer -= 1;
            if (projected.shieldTimer <= 0) {
              delete projected.shieldSourceId;
            }
          }
          updateShield(regular);
          wardenExpired ||= projected.shieldTimer <= 0;
          regularExpired ||= regular.shieldTime <= 0;
        });
      }
      if (warden.abilityActiveFrames > 0 && projected.shieldTimer > 0) {
        drawCable(ctx, warden.position, projected.position, PALETTE.SHIELD);
      }
      if (projected.shieldTimer > 0) {
        drawRing(
          ctx,
          projected.position,
          (projected.r ?? 0) * SHIELD.RADIUS_RATIO,
          PALETTE.SHIELD,
          0.9
        );
      }
      if (regular.shieldTime > 0) {
        drawRing(
          ctx,
          regularPosition,
          (getShipKit('dart').size / 2) * SHIELD.RADIUS_RATIO,
          PALETTE.SHIELD,
          0.9
        );
      }
      drawShip(
        ctx,
        'warden',
        warden.position,
        0,
        FACTION_COLORS.ion,
        getShipKit('warden').size / 2
      );
      drawShip(ctx, 'dart', projected.position, 0, FACTION_COLORS.ember, projected.r ?? 0);
      drawShip(ctx, 'dart', regularPosition, 0, FACTION_COLORS.ember, getShipKit('dart').size / 2);
      drawShip(
        ctx,
        'dart',
        projectedAttacker,
        Math.PI,
        FACTION_COLORS.ember,
        getShipKit('dart').size / 2
      );
      drawShip(
        ctx,
        'dart',
        regularAttacker,
        Math.PI,
        FACTION_COLORS.ember,
        getShipKit('dart').size / 2
      );
      if (frame <= contactFrame) {
        const progress = Math.min(1, frame / contactFrame);
        drawLaser(
          ctx,
          {
            x: projectedAttacker.x + (projectedImpact.point.x - projectedAttacker.x) * progress,
            y: projectedAttacker.y,
          },
          incomingVelocity,
          PALETTE.LASER_ENEMY
        );
        drawLaser(
          ctx,
          {
            x: regularAttacker.x + (regularImpact.point.x - regularAttacker.x) * progress,
            y: regularAttacker.y,
          },
          incomingVelocity,
          PALETTE.LASER_ENEMY
        );
      } else {
        projectedReflected = true;
        regularReflected = true;
        if (frame < projectedHitFrame) {
          drawLaser(
            ctx,
            {
              x: projectedImpact.point.x + projectedVelocity.x * (frame - contactFrame),
              y: projectedImpact.point.y + projectedVelocity.y * (frame - contactFrame),
            },
            projectedVelocity,
            PALETTE.LASER_LOCAL
          );
        }
        if (frame < regularHitFrame) {
          drawLaser(
            ctx,
            {
              x: regularImpact.point.x + regularVelocity.x * (frame - contactFrame),
              y: regularImpact.point.y + regularVelocity.y * (frame - contactFrame),
            },
            regularVelocity,
            PALETTE.LASER_LOCAL
          );
        }
      }
      if (frame === contactFrame) {
        drawRing(
          ctx,
          projected.position,
          (projected.r ?? 0) * SHIELD.RADIUS_RATIO + 10,
          PALETTE.SHIELD,
          0.9
        );
        drawRing(
          ctx,
          regularPosition,
          (getShipKit('dart').size / 2) * SHIELD.RADIUS_RATIO + 10,
          PALETTE.SHIELD,
          0.9
        );
      }
      if (frame >= projectedHitFrame && frame < projectedHitFrame + 6) {
        drawRing(
          ctx,
          projectedAttacker,
          getShipKit('dart').size / 2 + 15,
          PALETTE.LASER_LOCAL,
          0.9
        );
      }
      if (frame >= regularHitFrame && frame < regularHitFrame + 6) {
        drawRing(ctx, regularAttacker, getShipKit('dart').size / 2 + 15, PALETTE.LASER_LOCAL, 0.9);
      }
      drawTag(
        ctx,
        `E → ally · ${projected.shieldTimer > 0 ? secondsLabel(projected.shieldTimer) : 'expired'}`,
        80,
        132,
        PALETTE.SHIELD
      );
      drawTag(
        ctx,
        `F own shield · ${regular.shieldTime > 0 ? secondsLabel(regular.shieldTime) : 'expired'}`,
        80,
        236,
        PALETTE.SHIELD
      );
      drawTag(
        ctx,
        'both shields reflect · attacker takes the return shot',
        300,
        286,
        PALETTE.HUD_MUTED
      );
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
          const color = wave.id === 'fast' ? PALETTE.LASER_LOCAL : FACTION_COLORS.ion;
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
  state: 'loose' | 'orbiting' | 'broken';
  health: number;
  maxHealth: number;
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
  if (pickup.state === 'broken' || pickup.health >= pickup.maxHealth) {
    return;
  }
  const width = radius * 2.4;
  const top = screen.y - radius * 1.5 - 6;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.moveTo(screen.x - width / 2, top);
  ctx.lineTo(screen.x + width / 2, top);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PALETTE.HEALTH;
  ctx.beginPath();
  ctx.moveTo(screen.x - width / 2, top);
  ctx.lineTo(screen.x - width / 2 + width * Math.max(0, pickup.health / pickup.maxHealth), top);
  ctx.stroke();
  ctx.restore();
}

function makePickupsDemo(): Demo {
  const manager = new SatellitePickupManager(new RNGService(0x7a11ce55));
  const created = manager.createPickups(2);
  const first = created[0];
  if (first === undefined) {
    throw new Error('wiki-media verification failed: pickup manager did not create Echo');
  }
  const owner = {
    id: 'pilot',
    position: { x: 0, y: 0 },
    radius: radiusFromMass(100),
    health: 100,
    exploding: false,
  };
  const collected = manager.collect(first.id, owner, manager.nextOrbitPhaseFor(owner.id));
  invariant(
    collected?.state === 'orbiting' && collected.ownerId === 'pilot',
    'pickup collection did not enter orbiting state'
  );
  let sawOrbiting = false;
  let sawDamaged = false;
  let interceptedShot = false;
  const impactFrame = 12;
  return {
    id: 'pickups',
    posterFrame: 14,
    verify: () => {
      const current = manager.getPickup(first.id);
      invariant(sawOrbiting, 'pickup orbit did not run');
      invariant(interceptedShot && sawDamaged, 'pickup did not intercept a hostile shot');
      invariant(
        current !== undefined && current.state === 'orbiting',
        'damaged pickup stopped orbiting'
      );
      invariant(
        current !== undefined && current.health === current.maxHealth - DAMAGE.LASER_HIT,
        'pickup health changed by the wrong amount'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SATELLITE PICKUPS',
        'auto-collect nearby Echo → orbit indefinitely while it intercepts fire',
        frame,
        PALETTE.SATELLITE_PICKUP
      );
      runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
        manager.update([owner]);
        if (!interceptedShot && frame >= impactFrame) {
          const damaged = manager.damage(first.id, DAMAGE.LASER_HIT);
          interceptedShot = damaged !== null;
        }
        const current = manager.getPickup(first.id);
        sawOrbiting ||= current?.state === 'orbiting';
        sawDamaged ||= current !== undefined && current.health < current.maxHealth;
      });
      const pickups = manager.getAllPickups();
      const firstPickup = pickups.find((pickup) => pickup.id === first.id);
      if (firstPickup) {
        if (firstPickup.state === 'orbiting') {
          drawRing(
            ctx,
            { x: 0, y: 0 },
            Math.max(42, owner.radius + firstPickup.radius + SATELLITE_PICKUP.ORBIT_GAP),
            PALETTE.SATELLITE_PICKUP,
            0.28
          );
        }
        const pickupScale = 1.35;
        if (frame <= impactFrame && firstPickup.state === 'orbiting') {
          const shotProgress = Math.min(1, frame / impactFrame);
          const shotPosition = {
            x: firstPickup.position.x - 120 + shotProgress * 120,
            y: firstPickup.position.y,
          };
          drawLaser(
            ctx,
            { x: shotPosition.x * pickupScale, y: shotPosition.y * pickupScale },
            { x: 1, y: 0 },
            PALETTE.LASER_ENEMY
          );
        }
        drawPickup(ctx, firstPickup, pickupScale);
      }
      const loose = pickups.find((pickup) => pickup.id !== first.id);
      if (loose) {
        drawPickup(ctx, loose, 0.35);
      }
      drawShip(ctx, 'dart', { x: 0, y: 0 }, 0, FACTION_COLORS.ion, getShipKit('dart').size / 2);
      drawTag(
        ctx,
        firstPickup?.state === 'orbiting'
          ? `Echo orbit · ${firstPickup.health}/${firstPickup.maxHealth} HP`
          : firstPickup?.state === 'loose'
            ? 'Echo released'
            : 'Echo collected',
        340,
        112,
        PALETTE.SATELLITE_PICKUP
      );
      drawTag(
        ctx,
        'auto-collect ≤ 140 wu · hostile shot removes 25 HP',
        320,
        286,
        PALETTE.HUD_MUTED
      );
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
