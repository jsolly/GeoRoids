import type { ShipKitId } from '../shared-types';
import { scannedMaterial } from '../src/entities/ship/surveyScan';
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
import process from 'node:process';
import { createCanvas } from 'canvas';
import { AsteroidManager } from '../server/core/AsteroidManager';
import type { GameEntity } from '../server/core/EntityManager';
import { LootManager } from '../server/core/LootManager';
import { RNGService } from '../server/core/RNGService';
import { SatellitePickupManager } from '../server/core/SatellitePickupManager';
import {
  ASTEROID_INTERACTIONS,
  previewChargedReflections,
  segmentCircleContact,
} from '../shared/asteroidPhenomena';
import { circlesOverlap } from '../shared/combat';
import { SATELLITE_PROFILES } from '../shared/eoSatellites';
import { FURNACES, furnaceReward } from '../shared/furnaces';
import {
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
  LOOT_BLAST,
} from '../shared/lootBlast';
import { cruiseSpeed } from '../shared/shipFlight';
import { applyLootMass, GROWTH, lootOverlap } from '../shared/shipGrowth';
import type { AsteroidData, Position, SatellitePickupTypeId, Velocity } from '../shared-types';
import { DAMAGE, GAME, PALETTE, SATELLITE_PICKUP, SHIP, TITLE, VISUAL } from '../src/constants';
import { lootScreenRadius, lootStrokeColor } from '../src/entities/loot/lootRenderer';
import { drawAsteroidMaterialDetails } from '../src/entities/roid/materialArt';
import { drawRoidInteractionCues } from '../src/entities/roid/roidRenderer';
import { drawEoSatelliteOutline } from '../src/entities/satellite/eoOutlines';
import { advanceCruiseVelocity } from '../src/entities/ship/cruiseMotion';
import { getKitHullOutline, projectHullPoint } from '../src/entities/ship/hullOutlines';
import { Ship } from '../src/entities/ship/Ship';
import {
  type AbilityHost,
  type AbilityWorld,
  activateAbilityOnHost,
  pullHarpoonTarget,
  tickAbilityHost,
} from '../src/entities/ship/shipAbilities';
import { getShipKit, hullRadiusForKit } from '../src/entities/ship/shipKits';
import { strokeKitHullOutline, strokePhosphorSegment } from '../src/entities/ship/shipRenderer';
import { applyShipImpactFlash, tickShipImpactFlash } from '../src/entities/ship/shipUtils';
import { steeringTurn } from '../src/input/pointerSteering';
import { stepAsteroidMotion } from '../src/physics/asteroidMotion';
import {
  applyShockwaveToBody,
  easedRingRadius,
  ringAlpha,
  SHOCKWAVE_WAVES,
  waveVisualProgress,
} from '../src/physics/shockwave';
import { extractIsoContours } from '../src/physics/terrain/contours';
import { sampleGradient, sampleHeight } from '../src/physics/terrain/heightfield';
import { getTerrainField } from '../src/physics/terrain/terrainSession';
import { drawContourLabels } from '../src/rendering/contourLabels';
import type { DrawingContext } from '../src/rendering/drawingContext';
import { drawFurnaceArtwork } from '../src/rendering/furnaceRenderer';
import {
  polygonPoints,
  strokePhosphorPolyline,
  thrusterFlameGeometry,
} from '../src/rendering/vectorJuice';
import { media } from '../src/wiki/media';
import { recordSatelliteDemo, type SatelliteDemoPanel } from './wiki-satellite-demo';

type RenderContext = DrawingContext;
type MediaId =
  | 'surveyor'
  | 'hauler'
  | 'movement'
  | 'terrain'
  | 'loot'
  | 'reflection'
  | 'split'
  | 'satellites'
  | 'pickups'
  | 'survival';

const MEDIA_IDS: readonly MediaId[] = [
  'surveyor',
  'hauler',
  'movement',
  'terrain',
  'loot',
  'reflection',
  'split',
  'satellites',
  'pickups',
  'survival',
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
  color: string
): void {
  drawEoSatelliteOutline(ctx, typeId, radius, angle, color);
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
  color: string = PALETTE.LOCAL,
  radius = getShipKit(kitId).size / 2,
  thrusting = false
): void {
  const screen = screenPoint(position);
  assertSubjectBounds(`${kitId} hull`, screen, radius);
  renderHull(ctx, screen.x, screen.y, radius, angle, color, kitId);
  if (!thrusting) {
    return;
  }
  const outline = getKitHullOutline(kitId);
  for (const aft of outline.nozzles) {
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
  const half = VISUAL.LASER_LENGTH / 2;
  renderSegment(
    ctx,
    screen.x - dx * half,
    screen.y - dy * half,
    screen.x + dx * half,
    screen.y + dy * half,
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
  ctx.shadowBlur = VISUAL.LASER_GLOW;
  ctx.lineWidth = VISUAL.LASER_STROKE_WIDTH;
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
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,

    harpoonTargetId: null,
    mass: GROWTH.BASE_MASS,
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

function makeSurveyorDemo(): Demo {
  const host = makeAbilityHost('surveyor', { x: 0, y: 0 });
  const teammate = makeAbilityHost('hauler', { x: 210, y: 35 });
  const rocks = [
    makeAsteroid('scan-ice', { x: -100, y: -50 }, 26, 'ice'),
    makeAsteroid('scan-metal', { x: 100, y: -35 }, 26, 'metal'),
    makeAsteroid('scan-rubble', { x: 40, y: 75 }, 26, 'rubble'),
  ];
  const activated = activateAbilityOnHost(host);
  invariant(
    activated.activated && activated.abilityId === 'surveyScan',
    'Surveyor scan must activate'
  );
  let classified = false;
  let sharedClassification = false;
  let tagged = false;
  return {
    id: 'surveyor',
    posterFrame: 10,
    verify: () => {
      invariant(
        classified && sharedClassification && tagged,
        'Scan must classify and share minerals'
      );
      runSimulationTicks(host.abilityActiveFrames + 1, () => tickAbilityHost(host));
      const scannedRock = rocks[0];
      if (scannedRock === undefined) {
        throw new Error('Survey fixture must retain its first rock');
      }
      invariant(
        scannedMaterial(host, scannedRock) === undefined &&
          rocks[0]?.surveyedBy?.includes(host.id ?? '') === true,
        'Survey tag did not persist after the visual scan ended'
      );
    },
    render: (ctx, frame) => {
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => tickAbilityHost(host));
      }
      drawFrameChrome(
        ctx,
        'SURVEYOR · MINERAL SCAN',
        'E scan → shared crew radar → persistent delivery tag',
        frame
      );
      drawRing(ctx, host.position, 190, PALETTE.HUD_MUTED, 0.18);
      drawShip(ctx, 'surveyor', host.position, Math.PI / 2, PALETTE.LOCAL);
      drawShip(ctx, 'hauler', teammate.position, Math.PI, PALETTE.REMOTE);
      for (const rock of rocks) {
        const material = scannedMaterial(host, rock);
        classified ||= material !== undefined;
        const teammateMaterial = material;
        sharedClassification ||= teammateMaterial !== undefined;
        if (material !== undefined) {
          rock.surveyedBy ??= [];
          if (!rock.surveyedBy.includes(host.id ?? '')) {
            rock.surveyedBy.push(host.id ?? '');
          }
          tagged = true;
        }
        const point = screenPoint(rock.position);
        ctx.fillStyle =
          material === 'metal'
            ? '#FDE68A'
            : material === 'ice'
              ? '#A5F3FC'
              : material === 'rubble'
                ? '#FDBA74'
                : PALETTE.HUD_MUTED;
        ctx.beginPath();
        if (material === 'metal') {
          ctx.rect(point.x - 5, point.y - 5, 10, 10);
        } else if (material === 'rubble') {
          ctx.moveTo(point.x, point.y - 6);
          ctx.lineTo(point.x + 6, point.y + 5);
          ctx.lineTo(point.x - 6, point.y + 5);
          ctx.closePath();
        } else {
          ctx.arc(point.x, point.y, material ? 5 : 2, 0, Math.PI * 2);
        }
        ctx.fill();
        if (material) {
          drawTag(ctx, material, point.x + 15, point.y + 8, PALETTE.HUD);
        }
      }
      drawTag(
        ctx,
        host.abilityActiveFrames > 0 ? 'SCAN ACTIVE · CREW RADAR' : 'SCAN EXPIRED · TAG KEPT',
        210,
        325
      );
      drawTag(ctx, 'Surveyor + teammate see the same marks', 330, 110, PALETTE.REMOTE);
    },
  };
}

function makeHaulerDemo(): Demo {
  const furnace = FURNACES[0];
  if (furnace === undefined) {
    throw new Error('wiki-media verification failed: no furnace destination');
  }
  const anchor = furnace.position;
  const host = makeAbilityHost('hauler', { x: anchor.x - 140, y: anchor.y });
  const target = {
    ...makeAsteroid('demo-rock', { x: anchor.x - 220, y: anchor.y }, 34, 'metal'),
    kind: 'asteroid' as const,
    surveyedBy: ['surveyor-demo'],
  };
  const surveyor = makeAbilityHost('surveyor', { x: anchor.x - 235, y: anchor.y - 62 });
  const scan = activateAbilityOnHost(surveyor);
  invariant(
    scan.activated && scan.abilityId === 'surveyScan',
    'Surveyor scan did not tag the haul'
  );
  invariant(scannedMaterial(surveyor, target) === 'metal', 'Surveyor scan missed the hauled metal');
  const world: AbilityWorld = {
    asteroids: [target],
  };
  const bodies = world.asteroids;
  const result = activateAbilityOnHost(host, world);
  invariant(
    result.activated && result.abilityId === 'harpoon',
    'Hauler E did not latch a nearby rock'
  );
  invariant(host.harpoonTargetId === target.id, 'Hauler selected the wrong target');
  let attachedTicks = 0;
  let sawMomentumPreserved = false;
  let delivered = false;
  let releasedFrame: number | undefined;
  let targetRotation = 0;
  const targetAngularVelocity = 0.14;
  const targetSpeed = 0.49;
  host.velocity.x = targetSpeed;
  target.velocity.x = targetSpeed;
  return {
    id: 'hauler',
    posterFrame: 4,
    verify: () => {
      invariant(attachedTicks > 0, 'Hauler tow cable did not stay attached');
      invariant(sawMomentumPreserved, 'towed asteroid did not preserve its momentum');
      invariant(delivered, 'towed asteroid did not reach a furnace');
      invariant(
        releasedFrame !== undefined && host.harpoonTargetId === null,
        'E did not release after delivery'
      );
      invariant(
        target.surveyedBy?.includes('surveyor-demo') === true,
        'delivery lost the Surveyor tag'
      );
      const recipients = new Set(['hauler-demo', ...(target.surveyedBy ?? [])]);
      const reward = furnaceReward(target);
      invariant(
        reward > 0 && recipients.size === 2,
        'delivery reward did not include both contributors'
      );
      invariant(Math.abs(targetRotation) > 1, 'towed rock did not visibly spin');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'HAULER · TOW CABLE',
        'E attach → keep momentum → tow to furnace → shared score',
        frame,
        '#FDE68A'
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          if (!delivered) {
            pullHarpoonTarget(host, bodies);
            attachedTicks += host.harpoonTargetId === target.id ? 1 : 0;
            sawMomentumPreserved ||= Math.abs(target.velocity.x - targetSpeed) < 0.02;
            host.position.x += host.velocity.x;
            target.position.x += target.velocity.x;
            if (
              Math.hypot(
                target.position.x - furnace.position.x,
                target.position.y - furnace.position.y
              ) <= furnace.radius
            ) {
              delivered = true;
              const released = activateAbilityOnHost(host, world);
              invariant(
                released.activated && host.harpoonTargetId === null,
                'E did not release the tow cable'
              );
              releasedFrame = frame;
            }
          }
          targetRotation += targetAngularVelocity;
          tickAbilityHost(host);
        });
      }
      const displayScale = 0.62;
      const toScene = (position: Position): Position => ({
        x: (position.x - anchor.x) * displayScale,
        y: (position.y - anchor.y) * displayScale,
      });
      const displayHost = toScene(host.position);
      const sceneTarget = {
        x: target.position.x - anchor.x,
        y: target.position.y - anchor.y,
      };
      const displayTarget = toScene(target.position);
      const displaySurveyor = toScene(surveyor.position);
      if (!delivered) {
        drawRoid(ctx, { ...target, position: sceneTarget, rotation: targetRotation }, displayScale);
      }
      if (host.harpoonTargetId === target.id && !delivered) {
        drawCable(ctx, displayHost, displayTarget);
      }
      drawShip(
        ctx,
        'hauler',
        displayHost,
        0,
        PALETTE.LOCAL,
        hullRadiusForKit('hauler') * displayScale
      );
      drawShip(
        ctx,
        'surveyor',
        displaySurveyor,
        Math.PI / 2,
        PALETTE.REMOTE,
        hullRadiusForKit('surveyor') * displayScale
      );
      const furnaceScreen = screenPoint({ x: 0, y: 0 });
      drawFurnaceArtwork(
        ctx,
        furnaceScreen.x,
        furnaceScreen.y,
        furnace.radius * displayScale,
        frame * VISUAL.THRUSTER_FLICKER_MS
      );
      drawTag(ctx, furnace.name, furnaceScreen.x + 35, furnaceScreen.y - 20, PALETTE.SATELLITE);
      drawTag(
        ctx,
        delivered
          ? `DELIVERED · ${furnaceReward(target)} points each`
          : host.harpoonTargetId === target.id
            ? 'tow cable active · rock trails behind'
            : 'E · attach an asteroid',
        310,
        110,
        '#FDE68A'
      );
      drawTag(
        ctx,
        'Surveyor scan → Hauler tow → furnace → both score',
        400,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makeMovementDemo(): Demo {
  const state = {
    position: { x: -500, y: 160 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    mass: 1,
    thrust: SHIP.THRUST,
  };
  const positions: Position[] = [copyPosition(state.position)];
  const speeds: number[] = [0];
  const angles: number[] = [0];
  const totalTicks = FRAME_COUNT * SIM_TICKS_PER_FRAME;
  for (let tick = 0; tick < totalTicks; tick++) {
    if (tick >= 12 * SIM_TICKS_PER_FRAME && tick < 18 * SIM_TICKS_PER_FRAME) {
      state.angle += steeringTurn(
        state.angle,
        Math.PI / 6,
        (SHIP.TURN_SPEED * Math.PI) / (180 * GAME.FPS)
      );
    }
    advanceCruiseVelocity(state, cruiseSpeed(1, SHIP.MAX_VELOCITY));
    state.position.x += state.velocity.x;
    state.position.y += state.velocity.y;
    if ((tick + 1) % SIM_TICKS_PER_FRAME === 0) {
      positions.push(copyPosition(state.position));
      speeds.push(Math.hypot(state.velocity.x, state.velocity.y));
      angles.push(state.angle);
    }
  }
  return {
    id: 'movement',
    posterFrame: 20,
    verify: () => {
      invariant(positions.length === FRAME_COUNT + 1, 'movement frame count changed');
      invariant((speeds[10] ?? 0) > 0, 'automatic thrust did not accelerate');
      invariant((angles[20] ?? 0) > 0, 'steering did not turn the nose');
      invariant((speeds.at(-1) ?? 0) > 0, 'releasing steering stopped propulsion');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'MOVEMENT · ALWAYS-ON THRUST',
        'steer → turn · release → keep flying',
        frame,
        PALETTE.LOCAL
      );
      const position = positions[frame + 1] ?? state.position;
      const trailStart = positions[Math.max(0, frame - 9)] ?? position;
      const displayScale = 0.3;
      const a = screenPoint(trailStart, displayScale);
      const b = screenPoint(position, displayScale);
      renderSegment(ctx, a.x, a.y, b.x, b.y, PALETTE.LOCAL, 1, 2);
      drawShip(
        ctx,
        'surveyor',
        { x: position.x * displayScale, y: position.y * displayScale },
        angles[frame + 1] ?? 0,
        PALETTE.LOCAL,
        getShipKit('surveyor').size / 2,
        true
      );
      drawTag(
        ctx,
        frame < 12
          ? 'automatic thrust'
          : frame < 18
            ? 'steer · turning'
            : 'released · still flying',
        350,
        112,
        PALETTE.LOCAL
      );
      drawTag(ctx, `speed ${speeds[frame + 1]?.toFixed(2) ?? '0.00'}`, 470, 286, PALETTE.HUD_MUTED);
    },
  };
}

function makeTerrainDemo(): Demo {
  const field = getTerrainField();
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
    angle: 0,
    mass: 1,
    thrust: SHIP.THRUST,
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
        'automatic thrust + downhill force',
        frame,
        PALETTE.CONTOUR
      );
      if (frame > 0) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          advanceCruiseVelocity(state, cruiseSpeed(1, SHIP.MAX_VELOCITY));
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
        'surveyor',
        { x: 0, y: 0 },
        0,
        PALETTE.LOCAL,
        getShipKit('surveyor').size / 2,
        true
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
  ctx.shadowBlur = VISUAL.LOOT_GLOW;
  ctx.lineWidth = VISUAL.LOOT_STROKE_WIDTH;
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
  let magnetized = false;
  const parkedCollector = { x: -20, y: 0 };
  const shipPositionAt = (frame: number): Position => {
    if (frame <= 12) {
      return { x: shooterStart.x + frame * 50, y: 0 };
    }
    if (frame >= 24) {
      return parkedCollector;
    }
    return { x: -400 + (frame - 12) * 35, y: 0 };
  };
  const collectorAt = (position: Position): GameEntity =>
    ({
      exploding: false,
      health: 100,
      position,
    }) as GameEntity;
  return {
    id: 'loot',
    posterFrame: 26,
    verify: () => {
      invariant(armed, 'loot arm range was never reached');
      invariant(detonated, 'loot blast never triggered');
      invariant(firstRemoved && contactFrame >= 0, 'loot shot did not remove the first drop');
      invariant(collected && mass > initialMass, 'loot mass growth never applied');
      invariant(rock.position.x > 44, 'loot blast did not push the small rock');
      invariant(magnetized, 'remaining shard never magnetized toward the hull');
      invariant(lootManager.get(secondDrop.id) === undefined, 'collected shard remained in loot');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'LOOT · ARM + COLLECT',
        'laser hits shard → blast pushes rock → remaining shard magnetizes',
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
      let liveSecond = lootManager.get(secondDrop.id);
      if (secondVisible && !collected && liveSecond) {
        runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
          lootManager.expire(frame, [collectorAt(shooter)]);
        });
        liveSecond = lootManager.get(secondDrop.id);
        if (liveSecond && liveSecond.position.x < secondDrop.position.x) {
          magnetized = true;
        }
        if (
          liveSecond &&
          lootOverlap(shooter, hullRadiusForKit('surveyor'), liveSecond.position, liveSecond.radius)
        ) {
          const removed = lootManager.remove(secondDrop.id);
          if (removed !== undefined) {
            collected = true;
            mass = applyLootMass(mass, removed.mass);
            liveSecond = undefined;
          }
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
      if (secondVisible && !collected && liveSecond) {
        drawLootDiamond(
          ctx,
          liveSecond.position,
          liveSecond.radius,
          lootStrokeColor(liveSecond.kind),
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
      const shipRadius = hullRadiusForKit('surveyor');
      drawShip(
        ctx,
        'surveyor',
        { x: shooter.x * displayScale, y: shooter.y * displayScale },
        0,
        PALETTE.LOCAL,
        shipRadius,
        frame >= 8 && frame <= 12
      );
      drawTag(
        ctx,
        collected
          ? 'shard collected · mass gained'
          : detonated
            ? 'blast pushed the rock'
            : armed
              ? 'laser can reach the shard'
              : 'approach the shard',
        332,
        112,
        PALETTE.LOOT
      );
      let growthTag = 'laser removes the first shard';
      if (collected) {
        growthTag = 'hull size unchanged';
      } else if (magnetized) {
        growthTag = 'shard pulling toward the hull';
      } else if (secondVisible) {
        growthTag = 'new shard ahead';
      }
      drawTag(ctx, growthTag, 350, 286, PALETTE.HUD_MUTED);
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
        drawLaser(ctx, { x: 150 - frame * 16, y: 0 }, { x: -5, y: 0 }, PALETTE.LASER_LOCAL);
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

function makeSatellitesDemo(): Demo {
  const recording = recordSatelliteDemo(FRAME_COUNT, SIM_TICKS_PER_FRAME);
  invariant(recording.length === FRAME_COUNT, 'satellite recording length changed');
  invariant(recording[0]?.length === 6, 'satellite recording lost a profile');
  invariant(
    new Set(SATELLITE_PROFILES.map((profile) => profile.typeId)).size === 6,
    'satellite pickup hulls are not all represented'
  );
  return {
    id: 'satellites',
    posterFrame: 12,
    verify: () => {
      invariant(
        recording.every((panels) => panels.length === 6),
        'satellite recording does not keep all profiles visible'
      );
      invariant(
        recording.some((panels) =>
          panels.some((panel) => Math.hypot(panel.pickup.position.x, panel.pickup.position.y) > 0)
        ),
        'satellite recording contains no pickup motion'
      );
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'EO SATELLITES',
        'six hulls · collectible interceptors',
        frame,
        PALETTE.SATELLITE
      );
      const panels: readonly SatelliteDemoPanel[] = recording[frame] ?? [];
      const displayScale = 0.3;
      for (const [index, panel] of panels.entries()) {
        const { pickup } = panel;
        const profile = SATELLITE_PROFILES.find((candidate) => candidate.typeId === pickup.typeId);
        if (profile === undefined) {
          continue;
        }
        const column = index % 2;
        const row = Math.floor(index / 2);
        const panelOrigin = {
          x: column === 0 ? -185 : 105,
          y: -85 + row * 80,
        };
        const position = {
          x: panelOrigin.x + pickup.position.x * displayScale,
          y: panelOrigin.y + pickup.position.y * displayScale,
        };
        const screen = screenPoint(position);
        ctx.save();
        ctx.translate(screen.x, screen.y);
        renderSatellite(ctx, pickup.typeId, 17, pickup.angle, pickup.color);
        ctx.restore();
        ctx.save();
        ctx.fillStyle = PALETTE.HUD;
        ctx.font = '700 18px Arial';
        ctx.fillText(profile.displayName, screen.x - 55, screen.y - 22);
        ctx.restore();
      }
      drawTag(ctx, 'six collectible hulls', 410, 315, PALETTE.HUD_MUTED);
    },
  };
}

interface PickupView {
  typeId: SatellitePickupTypeId;
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
  ctx.shadowColor = pickup.color;
  ctx.shadowBlur = 3;
  renderSatellite(ctx, pickup.typeId, radius, pickup.angle, pickup.color);
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

function drawShipHealthCapsule(ctx: RenderContext, ship: Ship): void {
  const screen = screenPoint(ship.position);
  const width = ship.r * 2.4;
  const y = screen.y - ship.r - 10;
  const left = screen.x - width / 2;
  const fraction = Math.max(0, Math.min(1, ship.health / ship.maxHealth));
  ctx.save();
  ctx.lineWidth = VISUAL.HEALTH_CAPSULE_HEIGHT;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = PALETTE.HUD_MUTED;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(left + width, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PALETTE.HEALTH;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(left + width * fraction, y);
  ctx.stroke();
  ctx.restore();
}

function makeSurvivalDemo(): Demo {
  const ship = new Ship({ position: { x: -92, y: 0 }, kitId: 'surveyor' });
  ship.angle = 0;
  const rock = makeAsteroid('survival-rock', { x: 130, y: 0 }, 32, 'rubble', 0.35);
  rock.velocity = { x: -1.4, y: 0 };
  let impacted = false;
  let impactFrame = -1;
  let postImpactTicks = 0;
  const initialHealth = ship.health;

  return {
    id: 'survival',
    posterFrame: 34,
    verify: () => {
      invariant(impacted && impactFrame >= 0, 'asteroid never reached the survival ship');
      invariant(
        ship.health === initialHealth - DAMAGE.ASTEROID_COLLISION,
        'environmental impact used the wrong damage amount'
      );
      invariant(!ship.exploding, 'one environmental impact should leave the ship alive');
      invariant(postImpactTicks > 0, 'survival scene did not continue after impact');
    },
    render: (ctx, frame) => {
      drawFrameChrome(
        ctx,
        'SURVIVAL · ASTEROID IMPACT',
        'environmental hit → 25 HP → keep flying',
        frame,
        PALETTE.DANGER
      );
      runSimulationTicks(SIM_TICKS_PER_FRAME, () => {
        if (!impacted) {
          const next = stepAsteroidMotion(rock.position, rock.velocity);
          rock.position = next.position;
          rock.velocity = next.velocity;
          if (circlesOverlap(ship.position, ship.r, rock.position, rock.size)) {
            ship.takeDamage(DAMAGE.ASTEROID_COLLISION, 'asteroid');
            applyShipImpactFlash(ship);
            ship.velocity = { x: 0.85, y: 0 };
            impacted = true;
            impactFrame = frame;
            // Keep the rock in view after contact while the ship clears the hazard.
            rock.velocity = { x: -0.15, y: 0 };
          }
        } else {
          ship.position.x += ship.velocity.x;
          const next = stepAsteroidMotion(rock.position, rock.velocity);
          rock.position = next.position;
          rock.velocity = next.velocity;
          postImpactTicks += 1;
          tickShipImpactFlash(ship);
        }
      });
      drawRoid(ctx, rock);
      drawShip(ctx, 'surveyor', ship.position, ship.angle, PALETTE.LOCAL, ship.r, impacted);
      drawShipHealthCapsule(ctx, ship);
      if (ship.impactFlashFrames > 0) {
        const progress = 1 - ship.impactFlashFrames / SHIP.IMPACT_FLASH_FRAMES;
        drawRing(ctx, ship.position, ship.r * (1.15 + progress * 0.55), PALETTE.DANGER, 0.85);
      }
      if (impacted) {
        drawArrow(ctx, ship.position, ship.velocity, PALETTE.LOCAL, 22);
      }
      drawTag(
        ctx,
        impacted ? `SURVIVES · ${ship.health}/${ship.maxHealth} HP` : 'asteroid approaching',
        365,
        112,
        impacted ? PALETTE.HEALTH : PALETTE.DANGER
      );
      drawTag(
        ctx,
        impacted
          ? `asteroid impact · ${DAMAGE.ASTEROID_COLLISION} HP · flight continues`
          : 'environmental hazard · steer clear or take one hit',
        340,
        286,
        PALETTE.HUD_MUTED
      );
    },
  };
}

function makePickupsDemo(): Demo {
  const manager = new SatellitePickupManager(new RNGService(0x7a11ce55));
  const created = manager.createPickups(2);
  const first = created[0];
  if (first === undefined) {
    throw new Error('wiki-media verification failed: pickup manager did not create Landsat 7');
  }
  const owner = {
    id: 'pilot',
    position: { x: 0, y: 0 },
    radius: hullRadiusForKit('surveyor'),
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
      invariant(interceptedShot && sawDamaged, 'pickup did not intercept a laser shot');
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
        'auto-collect nearby Landsat 7 → orbit indefinitely while it intercepts fire',
        frame,
        PALETTE.SATELLITE
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
            Math.max(
              SATELLITE_PICKUP.ORBIT_RADIUS,
              owner.radius + firstPickup.radius + SATELLITE_PICKUP.ORBIT_GAP
            ),
            PALETTE.SATELLITE,
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
            PALETTE.LASER_LOCAL
          );
        }
        drawPickup(ctx, firstPickup, pickupScale);
      }
      const loose = pickups.find((pickup) => pickup.id !== first.id);
      if (loose) {
        drawPickup(ctx, loose, 0.35);
      }
      drawShip(ctx, 'surveyor', { x: 0, y: 0 }, 0, PALETTE.LOCAL, getShipKit('surveyor').size / 2);
      drawTag(
        ctx,
        firstPickup?.state === 'orbiting'
          ? `${firstPickup.name} orbit · ${firstPickup.health}/${firstPickup.maxHealth} HP`
          : firstPickup?.state === 'loose'
            ? `${firstPickup.name} released`
            : `${firstPickup?.name ?? 'Landsat 7'} collected`,
        340,
        112,
        PALETTE.SATELLITE
      );
      drawTag(ctx, 'auto-collect ≤ 140 wu · laser removes 25 HP', 320, 286, PALETTE.HUD_MUTED);
    },
  };
}

function buildDemos(): Demo[] {
  return [
    makeSurveyorDemo(),
    makeHaulerDemo(),
    makeMovementDemo(),
    makeTerrainDemo(),
    makeLootDemo(),
    makeReflectionDemo(),
    makeSplitDemo(),
    makeSatellitesDemo(),
    makePickupsDemo(),
    makeSurvivalDemo(),
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
    throw new Error(
      `wiki-media verification failed: unreadable manifest (${error instanceof Error ? error.message : JSON.stringify(error)})`,
      { cause: error }
    );
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
