import { createHash, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import { boostOwnerIds, removeBoostOwner } from '../../shared/asteroidBoost';
import { asteroidShardMass } from '../../shared/asteroidMaterials';
import {
  ASTEROID_INTERACTIONS,
  advanceReflectionEnergy,
  seedAsteroidPhenomena,
  segmentCircleContact,
} from '../../shared/asteroidPhenomena';
import { findNearestAsteroidImpact, reflectVector } from '../../shared/asteroidReflection';
import { asteroidCrewNeeded, isColossalAsteroid } from '../../shared/asteroidScale';
import { isCombatantImmune, isWorldHazard, laserDamagesShips } from '../../shared/combat';
import { epochField } from '../../shared/epochField';
import { EXPLORATION_RANGE, ExplorationMap } from '../../shared/exploration';
import { FURNACES, furnaceReward, isFurnaceSector } from '../../shared/furnaces';
import { consumeTickAccumulator, GAME_TICK_MS, MAX_TICK_DEBT_MS } from '../../shared/gameClock';
import {
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
  LOOT_BLAST,
} from '../../shared/lootBlast';
import { readReleaseId, releaseField } from '../../shared/releaseId';
import {
  chooseOpenSectorSpawn,
  containBodyOutOfCompletedSectors,
  findSectorWallImpact,
  isInsideCompletedSector,
  isSectorExplorationComplete,
  shipOverlapsCompletedSector,
} from '../../shared/sectors';
import { advanceShipBoost, stopShipBoost } from '../../shared/shipBoost';
import { applyLootMass, applyShipMass, GROWTH } from '../../shared/shipGrowth';
import { boundedDiagnosticError, captureDiagnosticActorState } from '../../shared/stateDiagnostics';
import { SURVEY_PROBE } from '../../shared/surveyProbe';
import { parseSectorId, sectorAt, utcScoreSeason, WORLD } from '../../shared/world';
import { findWorldBoundaryImpact } from '../../shared/worldBoundary';
import type {
  ActiveCollabTag,
  AsteroidData,
  ExplorationTile,
  FurnaceDelivery,
  LootCollected,
  LootData,
  PlayerProjectileState,
  PlayerShotFired,
  Position,
  SatellitePickupCollected,
  SatellitePickupData,
  ServerEntityData,
  ServerGameState,
  ShipKitId,
  TapEjected,
  Velocity,
} from '../../shared-types';
import { CANVAS, DAMAGE, GAME, LASER, ROID, SATELLITE_PICKUP, SHIP } from '../../src/constants';
import { pointsForRoidSize } from '../../src/entities/roid/roidScore';
import {
  haulerUtilityOf,
  isResourceTapUtility,
  isTowCableUtility,
} from '../../src/entities/ship/haulerUtility';
import {
  activateAbilityOnHost,
  clearHaulerLatch,
  pullHarpoonTarget,
  setHaulerUtilityOnHost,
  setSurveyorUtilityOnHost,
  tickTapExtract,
} from '../../src/entities/ship/shipAbilities';
import {
  applyShipKitStats,
  getShipKit,
  hullRadiusForKit,
  SHIP_ABILITY,
} from '../../src/entities/ship/shipKits';
import { surveyorUtilityOf } from '../../src/entities/ship/surveyorUtility';
import { getAsteroidFieldRadius } from '../../src/physics/asteroidMotion';
import { checkBoundaryCollision } from '../../src/physics/collision/collisionDetection';
import { framesToMs, SHOCKWAVE_WAVES, type ShockwaveWaveSpec } from '../../src/physics/shockwave';
import { TERRAIN } from '../../src/physics/terrain/terrainConfig';
import { ensureTerrain, getTerrainSeed } from '../../src/physics/terrain/terrainSession';
import { getVelocityMagnitude } from '../../src/utils/mathUtils';
import { sanitizePlayerName } from '../../src/utils/playerName';
import { serverPerformanceMetrics } from '../performanceMetrics';
import { SERVER_RELEASE_ID } from '../release';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import { MapAssets } from '../world/MapAssets';
import { RegionalAsteroidField } from '../world/RegionalAsteroidField';
import {
  type PersistentPilot,
  type RestorableFlight,
  restorableFlight,
  type SavedWorld,
} from '../world/WorldStore';
import type { WorldPersistence, WorldPersistenceDiagnostics } from '../world/worldPersistence';
import {
  type AsteroidHitCause,
  type AsteroidHitOutcome,
  AsteroidManager,
  type ExpiredCollabHit,
} from './AsteroidManager.ts';
import { CollisionAuthority, separateShipFromAsteroid } from './CollisionAuthority';
import { EntityManager, type GameEntity } from './EntityManager';
import { GameLoopHealth, type GameLoopHealthSnapshot } from './GameLoopHealth';
import { LootManager } from './LootManager';
import { PlayerMotionService } from './PlayerMotionService';
import { RNGService } from './RNGService';
import { SatellitePickupManager } from './SatellitePickupManager';
import { ServerClock } from './ServerClock';
import { SurveyProbeManager } from './SurveyProbeManager';
import { spiderResources } from './spiderResources';
import { type SpiderAttack, TerrainSpiderManager } from './TerrainSpiderManager';

const PILOT_RESUME_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

interface ServerLaser {
  id: string;
  ownerId: string;
  readonly miningDamage: number;
  position: Position;
  prevPosition: Position;
  velocity: Velocity;
  distTraveled: number;
  hasExploded: boolean;
  energy: number;
  bounces: number;
  age: number;
  lastAsteroidId?: string;
}

type LaserAuxiliaryTarget = {
  id: string;
  position: Position;
  radius: number;
} & (
  | { kind: 'surveyProbe'; hostId: string; ownerId: string }
  | { kind: 'ship' | 'satellitePickup' | 'loot'; ownerId?: string }
);

function tapLootEjection(
  ship: Position,
  rock: Pick<AsteroidData, 'position' | 'size'>,
  burst: number
): { position: Position; velocity: Velocity } {
  const angle =
    Math.atan2(rock.position.y - ship.y, rock.position.x - ship.x) +
    (burst / (SHIP_ABILITY.TAP_EXTRACT_BURSTS - 1) - 0.5) * 1.4;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return {
    position: {
      x: rock.position.x + dx * rock.size,
      y: rock.position.y + dy * rock.size,
    },
    velocity: { x: dx * 3, y: dy * 3 },
  };
}

export interface AppliedAsteroidHit {
  applied: boolean;
  outcome: AsteroidHitOutcome['outcome'];
  asteroidId: string;
  playerId: string;
  points: number;
  newAsteroids: AsteroidData[];
  split: boolean;
  expiresAt?: number;
  origin?: Position;
}

export interface CombatBroadcast {
  targetId: string;
  attackerId: string;
  damage: number;
  remainingHealth: number;
  remainingLives: number;
  isDestroyed: boolean;
  targetType: 'player';
  destroyedAsteroidId?: string;
  newAsteroids?: AsteroidData[];
  asteroidScore?: { playerId: string; score: number };
  collabSplit?: boolean;
  origin?: { x: number; y: number };
}

type CombatSink = (result: CombatBroadcast) => void;

/** Matches client Laser.isExpired when the canvas is the internal playfield. */
const SERVER_LASER_MAX_DISTANCE = LASER.TRAVEL_DISTANCE_RATIO + CANVAS.INTERNAL_WIDTH;
/** 250 ms covers a delayed position packet at 30 Hz plus a brief browser/network hitch. */
export const PLAYER_SHOOT_POSE_ALLOWANCE_MS = 250;
/** Bounded positional rounding/muzzle disagreement in addition to the movement allowance. */
const PLAYER_SHOOT_MUZZLE_SLOP = 8;
/** Stationary/counter-thrust shots must not remain in the authoritative list forever. */
export const PLAYER_LASER_MAX_LIFETIME_MS = Math.ceil(5000 / GAME.MOTION_SCALE);
const MAX_PENDING_SATELLITE_PICKUP_EVENTS = 32;
const MAX_PENDING_LOOT_COLLECTIONS = 256;
/** World changes leave the loop once per second; a crash loses at most that window. */
const WORLD_FLUSH_FRAMES = GAME.FPS;
/**
 * How long shutdown waits for an in-flight commit before giving up on the
 * final flush. Railway kills the process ten seconds after SIGTERM: two go to
 * the transports, this plus the writer's own close deadline to persistence,
 * and the log flushes need the rest.
 */
const SHUTDOWN_IDLE_WAIT_MS = 1_500;

/** Resolves true when `promise` settles first, false when the wait runs out. */
function settledWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (!Number.isFinite(timeoutMs)) {
    return promise.then(() => true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** What the last flushed world row was built from; the row is only sent again when this changes. */
interface FlushedWorldRow {
  exploration: ExplorationTile[];
  completedSectors: number;
  scoreSeason: string;
  startedAt: number;
  asteroidDensityVersion: number;
  asteroidMotionVersion: number;
}

type PendingShockwave = {
  origin: Position;
  radius: number;
  impulse: number;
  fireAt: number;
};

export class GameEngine {
  private exploration = new ExplorationMap();
  private mapAssets = new MapAssets();
  private readonly regionalField: RegionalAsteroidField;
  private readonly worldSeed: number;
  private worldStartedAt: number;
  private scoreSeason: string;
  private readonly pilots = new Map<string, PersistentPilot>();
  private readonly completedSectors = new Set<string>();
  private managedField: boolean = true;
  private pendingFurnaceDeliveries: FurnaceDelivery[] = [];
  public entityManager: EntityManager;
  private asteroidManager: AsteroidManager;
  private lootManager: LootManager;
  private satellitePickupManager: SatellitePickupManager;
  private spiderManager: TerrainSpiderManager;
  private rngService: RNGService;
  private collisionAuthority = new CollisionAuthority();
  private combatSink: CombatSink | null = null;
  private gameTime = 0;
  private gameLoopInterval: NodeJS.Timeout | null = null;
  private isPaused: boolean = false; // Track if game is paused due to no players
  private lastTickAtMs = 0;
  /** When the previous clock step returned; the loop was free to read poses after it. */
  private lastTickFinishedAtMs = 0;
  private nextTickDueAtMs = 0;
  private tickAccumulatorMs = 0;
  private clockPrimed: boolean = false;
  private readonly loopHealth = new GameLoopHealth();
  /** Pilots whose saved row changed since the last flush; live pilots are captured at flush time. */
  private readonly dirtyPilots = new Set<string>();
  private lastFlushedWorldRow: FlushedWorldRow | undefined;
  private flushWaitingForIdle = false;
  private lastSimulationAtMs: number | undefined;
  private resolvedCollabHits: ExpiredCollabHit[] = [];
  private lasers: ServerLaser[] = [];
  private laserSeq = 0;
  private readonly laserNonce = randomUUID();
  private readonly surveyProbeManager = new SurveyProbeManager();
  public readonly playerMotion = new PlayerMotionService(this.completedSectors);
  private departedPlayers: string[] = [];
  private decoratedFieldId?: string | undefined;
  private pendingLootBlasts: Array<{
    lootId: string;
    position: Position;
    radius: number;
    shooterId: string;
  }> = [];
  private onAsteroidHits?: (hits: AppliedAsteroidHit[]) => void;
  private pendingAsteroidHits: AppliedAsteroidHit[] = [];
  private persistenceFailure: Error | undefined;
  private pendingShockwaves: PendingShockwave[] = [];
  private pendingShotSounds: Array<{ laser: ServerLaser; position: Position }> = [];
  private pendingLootCollections: LootCollected[] = [];
  private pendingTapEjections: TapEjected[] = [];
  private pendingSatellitePickupCollections: SatellitePickupCollected[] = [];
  private pendingSpiderAttacks: SpiderAttack[] = [];
  private readonly shootBudgets = new WeakMap<GameEntity, { tokens: number; at: number }>();
  private readonly laserExpiry = new WeakMap<ServerLaser, number>();
  private readonly damageStateLogs = new WeakMap<GameEntity, number>();

  constructor(
    rngSeed?: number,
    private readonly serverClock = new ServerClock(),
    private readonly persistence?: WorldPersistence
  ) {
    this.scoreSeason = utcScoreSeason(this.serverClock.now());
    // The saved world is read exactly once, here, before the loop starts.
    let loaded = persistence?.load();
    const saved = loaded?.world;
    if (
      persistence &&
      saved &&
      (saved.generation !== WORLD.generation || saved.scoreSeason !== this.scoreSeason)
    ) {
      logger.warn(
        'WORLD',
        'Saved world generation or score season does not match; resetting world',
        {
          savedGeneration: saved.generation,
          currentGeneration: WORLD.generation,
          savedScoreSeason: saved.scoreSeason,
          currentScoreSeason: this.scoreSeason,
        }
      );
      persistence.reset();
      loaded = undefined;
    }
    this.worldSeed = loaded?.world?.seed ?? rngSeed ?? TERRAIN.DEFAULT_SEED;
    this.worldStartedAt = loaded?.world?.startedAt ?? this.serverClock.now();
    this.rngService = new RNGService(this.worldSeed);
    this.regionalField = new RegionalAsteroidField(
      this.worldSeed,
      loaded?.sectors,
      this.completedSectors
    );
    if (loaded?.world) {
      this.exploration.restore(loaded.world.exploration);
      for (const id of loaded.world.completedSectors) {
        // Older worlds could complete a Works yard when the hearth sat on a
        // corner. Those sectors stay flyable so delivery still has an approach.
        if (isFurnaceSector(id)) {
          continue;
        }
        this.completedSectors.add(id);
      }
    }
    if ((saved?.asteroidMotionVersion ?? 0) < WORLD.asteroidMotionVersion) {
      this.regionalField.migrateSavedMotion();
    }
    if ((saved?.asteroidDensityVersion ?? 0) < WORLD.asteroidDensityVersion) {
      this.regionalField.migrateSavedSectors(this.completedSectors);
    }
    for (const pilot of loaded?.pilots ?? []) {
      this.pilots.set(pilot.id, pilot);
    }
    persistence?.onFailure((cause) => this.failPersistence(cause));
    this.entityManager = new EntityManager(this.rngService, () => this.getServerTime());
    this.asteroidManager = new AsteroidManager(this.rngService);
    this.lootManager = new LootManager(this.rngService);
    this.satellitePickupManager = new SatellitePickupManager(this.rngService);
    this.spiderManager = new TerrainSpiderManager(() => this.rngService.random());
    ensureTerrain(this.worldSeed);
  }

  public setCombatSink(sink: CombatSink | null): void {
    this.combatSink = sink;
  }

  /** Return epoch milliseconds from the process-monotonic server clock. */
  public getServerTime(): number {
    return this.serverClock.now();
  }

  private simulationNow(nowMs?: number): number {
    const serverNow = nowMs ?? this.getServerTime();
    if (!Number.isFinite(serverNow) || serverNow < 0) {
      throw new RangeError('Game clock requires finite non-negative server time');
    }
    if (this.lastSimulationAtMs !== undefined && serverNow < this.lastSimulationAtMs) {
      throw new RangeError('Game clock moved backwards');
    }
    this.lastSimulationAtMs = serverNow;
    return serverNow;
  }

  // Game loop management
  public startGameLoop(): void {
    if (this.gameLoopInterval) {
      return; // Already running
    }

    this.lastTickAtMs = this.getServerTime();
    this.lastTickFinishedAtMs = this.lastTickAtMs;
    this.lastSimulationAtMs = this.lastTickAtMs;
    this.nextTickDueAtMs = this.lastTickAtMs + GAME_TICK_MS;
    this.tickAccumulatorMs = 0;
    this.clockPrimed = true;
    this.gameLoopInterval = setInterval(() => {
      this.stepClock();
    }, GAME_TICK_MS);
  }

  /**
   * Advance the monotonic clock and catch up missed simulation frames.
   * A blocked event loop used to increment gameTime once per late interval
   * fire, which froze explode/respawn and made /health.world.gameTime look stuck.
   */
  public stepClock(nowMs?: number): number {
    const serverNow = this.simulationNow(nowMs);
    if (!this.clockPrimed) {
      this.lastTickAtMs = serverNow;
      this.lastTickFinishedAtMs = serverNow;
      this.nextTickDueAtMs = serverNow + GAME_TICK_MS;
      this.clockPrimed = true;
      return 0;
    }
    const elapsed = serverNow - this.lastTickAtMs;
    this.lastTickAtMs = serverNow;
    // Blocked time starts once the tick is overdue: the scheduled idle before
    // the due time is when the loop normally reads queued poses.
    const blockedFrom = Math.max(this.lastTickFinishedAtMs, this.nextTickDueAtMs);
    if (elapsed <= 0) {
      if (serverPerformanceMetrics.enabled) {
        serverPerformanceMetrics.recordClock({
          timerLatenessMs: Math.max(0, serverNow - this.nextTickDueAtMs),
          catchupTicks: 0,
          debtMs: this.tickAccumulatorMs,
          discardedDebtMs: 0,
        });
      }
      return 0;
    }
    const timerLatenessMs = Math.max(0, serverNow - this.nextTickDueAtMs);
    this.nextTickDueAtMs = serverNow + GAME_TICK_MS;
    this.tickAccumulatorMs += elapsed;
    const { frames, remainingMs, discardedMs } = consumeTickAccumulator(this.tickAccumulatorMs);
    if (serverPerformanceMetrics.enabled) {
      serverPerformanceMetrics.recordClock({
        timerLatenessMs,
        catchupTicks: frames,
        debtMs: Math.min(this.tickAccumulatorMs, MAX_TICK_DEBT_MS),
        discardedDebtMs: discardedMs,
      });
    }
    this.tickAccumulatorMs = remainingMs;
    for (let i = 0; i < frames; i++) {
      this.advanceOneFrame(serverNow);
    }
    // One span per clock step: the late arrival plus a slow catch-up, during
    // which the loop could not read poses. Recording it before the poll phase
    // drains the queue lets those poses be credited, and steps never merge.
    const finished = nowMs ?? this.getServerTime();
    this.playerMotion.recordBlockedSpan(blockedFrom, finished);
    this.lastTickFinishedAtMs = finished;
    this.loopHealth.observe({
      blockedMs: finished - blockedFrom,
      catchupTicks: frames,
      discardedMs,
      now: finished,
      gameTime: this.gameTime,
      players: this.getPlayerCount(),
      persistence: this.persistence?.diagnostics(),
    });
    return frames;
  }

  /** One 60 Hz frame: clock always ticks; combat/field only while a player is in. */
  public advanceOneFrame(nowMs?: number): void {
    const serverNow = this.simulationNow(nowMs);
    if (!serverPerformanceMetrics.enabled) {
      this.advanceOneFrameInternal(serverNow);
      return;
    }
    const startedAt = globalThis.performance.now();
    try {
      this.advanceOneFrameInternal(serverNow);
    } finally {
      serverPerformanceMetrics.recordTickDuration(globalThis.performance.now() - startedAt);
    }
  }

  private advanceOneFrameInternal(serverNow: number): void {
    if (this.persistenceFailure) {
      throw this.persistenceFailure;
    }
    this.ensureScoreSeason();
    this.gameTime++;
    if (this.isPaused) {
      return;
    }
    for (const id of this.entityManager.getStalePlayerIds()) {
      this.removePlayer(id);
      this.departedPlayers.push(id);
    }
    this.entityManager.updateExplosions();
    this.logRespawns(this.entityManager.updateRespawns());
    for (const id of this.playerMotion.step(serverNow)) {
      this.removePlayer(id);
      this.departedPlayers.push(id);
    }
    this.tickAbilities(serverNow);
    this.tickSurveyProbes(serverNow);
    this.advanceSpiderField();
    this.entityManager.updateHealthRegeneration();
    this.lootManager.expire(this.gameTime, this.entityManager.getAllEntities());
    this.collectLoot(serverNow);
    this.tickSatellitePickups();
    this.asteroidManager.updateMotion();
    for (const rock of this.asteroidManager.getAllAsteroids()) {
      if (rock.boost?.phase !== 'burning') {
        containBodyOutOfCompletedSectors(rock, this.completedSectors);
      }
    }
    this.processFurnaceDeliveries();
    if (this.gameTime % 60 === 0) {
      this.seedAsteroidInteractions();
    }
    this.emitAsteroidHits(this.advanceLasersAndResolveHits(serverNow));
    this.flushDueShockwaves(serverNow);
    this.flushExpiredCollabHits(serverNow);
    this.resolveAuthoritativeCombat();
    this.evaluateSectorProgress();
    // Activate newly reached sectors without replenishing harvested deposits.
    if (this.gameTime % 60 === 0) {
      this.ensureAsteroidField();
    }
    // Write-behind: everything that changed this second leaves the loop as one
    // batch. A commit still in flight means the next second carries the change.
    if (this.gameTime % WORLD_FLUSH_FRAMES === 0 && this.persistenceIdle()) {
      this.checkpointWorld();
    }
  }

  /** Combat pair + clock — scenario tests drive death→respawn without moving the belt. */
  public advanceCombatFrame(): void {
    this.gameTime++;
    if (this.isPaused) {
      return;
    }
    this.entityManager.updateExplosions();
    this.logRespawns(this.entityManager.updateRespawns());
    this.tickAbilities();
    this.advanceSpiderField();
    this.entityManager.updateHealthRegeneration();
  }

  public stopGameLoop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    this.lastTickAtMs = 0;
    this.lastTickFinishedAtMs = 0;
    this.nextTickDueAtMs = 0;
    this.tickAccumulatorMs = 0;
    this.clockPrimed = false;
    this.lastSimulationAtMs = undefined;
  }

  // Pause/resume functionality
  public updatePauseState(): void {
    const playerCount = this.getPlayerCount();

    if (playerCount === 0 && !this.isPaused) {
      this.isPaused = true;
      logger.info('🔄 Game paused - no players online');
      this.lasers = [];
      this.clearPendingFeedback();
      this.spiderManager.suspend();
      this.pendingSpiderAttacks = [];
      this.checkpointWorld();
    } else if (playerCount > 0 && this.isPaused) {
      this.isPaused = false;
      logger.info('▶️ Game resumed - players are back online');
      this.ensureAmbientWorld();
    } else if (playerCount > 0) {
      this.ensureAmbientWorld();
    }
  }

  private ensureAmbientWorld(): void {
    this.ensureSatellitePickups();

    // Asteroids are server-owned world state. A fresh active session must not
    // depend on a client's initAsteroids message to seed the belt.
    this.ensureAsteroidField();
  }

  public isGamePaused(): boolean {
    return this.isPaused;
  }

  /** Read-only snapshot for health checks and integration test barriers. */
  public getDiagnostics(): {
    isPaused: boolean;
    gameTime: number;
    players: number;
    asteroids: number;
    loot: number;
    satellitePickups: number;
    loop: GameLoopHealthSnapshot;
    persistence?: WorldPersistenceDiagnostics;
  } {
    const persistence = this.persistence?.diagnostics();
    return {
      isPaused: this.isPaused,
      gameTime: this.gameTime,
      players: this.getPlayerCount(),
      asteroids: this.asteroidManager.getAsteroidCount(),
      loot: this.lootManager.getCount(),
      satellitePickups: this.satellitePickupManager.getCount(),
      loop: this.loopHealth.snapshot(),
      ...(persistence ? { persistence } : {}),
    };
  }

  /**
   * Clear the persistent world explicitly for integration/E2E isolation.
   * Ordinary disconnects pause and preserve the world.
   */
  public resetForTesting(): void {
    const closeErrors: Error[] = [];
    for (const entity of this.entityManager.getAllEntities()) {
      if (entity.ws) {
        if (entity.ws.readyState === entity.ws.CLOSED) {
          continue;
        }
        try {
          entity.ws.close(1000, 'Test world reset');
        } catch (error) {
          closeErrors.push(
            new Error(`Failed to close socket for player ${entity.id}`, { cause: error })
          );
        }
      }
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, 'Test world reset could not close every player socket');
    }
    this.persistence?.reset();
    this.resetGameState();
    this.loopHealth.reset();
    this.isPaused = true;
    this.rngService.reset();
  }

  /** State and earned rewards persist; missed sounds/notifications do not. */
  private clearPendingFeedback(): void {
    this.pendingLootBlasts = [];
    this.pendingLootCollections = [];
    this.pendingTapEjections = [];
    this.pendingShotSounds = [];
    this.pendingSatellitePickupCollections = [];
    this.pendingFurnaceDeliveries = [];
  }

  // Clear ambient entities and pending combat without replacing player sessions.
  private clearWorldObjects(): void {
    // Clear all asteroids and pending collab resolutions
    this.asteroidManager.clearAsteroids();
    this.resolvedCollabHits = [];
    this.pendingShockwaves = [];
    this.lootManager.clear();
    this.lasers = [];
    this.surveyProbeManager.clear();
    this.departedPlayers = [];
    this.decoratedFieldId = undefined;
    this.clearPendingFeedback();
    this.pendingAsteroidHits = [];
    this.pendingSpiderAttacks = [];
    this.satellitePickupManager.clear();
    this.spiderManager.clear();
  }

  /** Atomic between-tick arrangement for the benchmark process's private control socket. */
  public prepareDiagnosticWorld(scenario: 'traversal' | 'combat'): void {
    this.clearWorldObjects();
    this.pendingFurnaceDeliveries = [];
    this.exploration.reset();
    this.mapAssets.reset();
    this.completedSectors.clear();
    this.rngService.reset();
    this.createAsteroids(scenario === 'combat' ? 80 : ROID.INITIAL_ROID_COUNT);
    this.seedAsteroidInteractions();
    this.ensureSatellitePickups();
  }

  private resetGameState(): void {
    this.regionalField.reset();
    this.pilots.clear();
    this.dirtyPilots.clear();
    this.lastFlushedWorldRow = undefined;
    this.managedField = true;
    this.clearWorldObjects();
    this.pendingFurnaceDeliveries = [];
    this.exploration.reset();
    this.mapAssets.reset();
    this.completedSectors.clear();
    this.playerMotion.reset();
    this.entityManager.clearAll();

    // Keep gameTime monotonic for the process lifetime. Zeroing it when the
    // last player leaves makes /health.world.gameTime look frozen on prod
    // between sessions; localhost stays connected so the tick appears fine.

    logger.debug('🧹 Game state reset - all entities and asteroids cleared');
  }

  // Entity operations
  public addPlayer(
    id: string,
    name: string,
    ws: WebSocket,
    position?: Position,
    kitId?: ShipKitId
  ): GameEntity {
    const spawn = this.choosePilotSpawn(position);
    const entity = this.entityManager.addPlayer(id, name, ws, spawn, kitId);
    this.updatePauseState();
    return entity;
  }

  public getCompletedSectors(): readonly string[] {
    return [...this.completedSectors].sort();
  }

  public revealArea(position: Position, range: number): void {
    this.exploration.reveal(position, range);
  }

  private choosePilotSpawn(requested?: Position): Position {
    const allies = this.entityManager
      .getAllEntities()
      .filter((actor) => actor.health > 0 && !actor.exploding && actor.respawnTimer === undefined)
      .map((actor) => actor.position);
    const spawn = chooseOpenSectorSpawn({
      completed: this.completedSectors,
      allies,
      ...(requested ? { previous: requested } : {}),
      random: () => this.rngService.random(),
    });
    return spawn;
  }

  private ensurePilotInOpenSector(entity: GameEntity): boolean {
    const radius = hullRadiusForKit(entity.kitId);
    if (
      !isInsideCompletedSector(entity.position, this.completedSectors) &&
      !shipOverlapsCompletedSector(entity.position, radius, this.completedSectors)
    ) {
      return false;
    }
    entity.harpoonTargetId = null;
    delete entity.harpoonLatchPos;
    const heading =
      Math.hypot(entity.velocity.x, entity.velocity.y) > 1e-4
        ? entity.velocity
        : { x: Math.cos(entity.angle), y: Math.sin(entity.angle) };
    containBodyOutOfCompletedSectors(entity, this.completedSectors, {
      radius,
      bias: heading,
    });
    if (
      isInsideCompletedSector(entity.position, this.completedSectors) ||
      shipOverlapsCompletedSector(entity.position, radius, this.completedSectors)
    ) {
      entity.velocity = { x: 0, y: 0 };
      delete entity.knockbackVelocityLimit;
      entity.position = this.choosePilotSpawn(entity.position);
    }
    entity.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
    this.playerMotion.invalidateLife(entity.id, this.getServerTime());
    return true;
  }

  public evaluateSectorProgress(): string[] {
    const tiles = this.exploration.snapshot();
    const candidates = new Set<string>([
      ...this.regionalField.visitedSectorIds(),
      ...this.entityManager.getAllEntities().map((entity) => sectorAt(entity.position).id),
      ...this.asteroidManager.getAllAsteroids().map((rock) => sectorAt(rock.position).id),
    ]);
    const remaining = new Map<string, number>();
    for (const id of candidates) {
      remaining.set(id, 0);
    }
    for (const rock of this.asteroidManager.getAllAsteroids()) {
      const id = sectorAt(rock.position).id;
      remaining.set(id, (remaining.get(id) ?? 0) + 1);
    }
    for (const [id, rocks] of this.regionalField.dormantSectors()) {
      remaining.set(id, (remaining.get(id) ?? 0) + rocks.length);
    }
    const newlyCompleted: string[] = [];
    for (const id of candidates) {
      if (this.completedSectors.has(id)) {
        continue;
      }
      const parsed = parseSectorId(id);
      if (!parsed || isFurnaceSector(id) || !this.regionalField.hasVisited(id)) {
        continue;
      }
      if ((remaining.get(id) ?? 0) > 0) {
        continue;
      }
      if (!isSectorExplorationComplete(tiles, parsed.x, parsed.y)) {
        continue;
      }
      this.completedSectors.add(id);
      newlyCompleted.push(id);
    }
    if (newlyCompleted.length > 0) {
      for (const entity of this.entityManager.getAllEntities()) {
        this.ensurePilotInOpenSector(entity);
      }
    }
    return newlyCompleted;
  }

  public removePlayer(id: string): GameEntity | undefined {
    this.capturePilot(id);
    this.playerMotion.forgetActor(id);
    const departing = this.getPlayer(id);
    if (departing) {
      this.cancelArmedBoost(departing.id, departing.harpoonTargetId);
      departing.harpoonTargetId = null;
      delete departing.harpoonLatchPos;
    }
    this.satellitePickupManager.releaseOwner(id);
    const entity = this.entityManager.removeEntity(id);
    this.updatePauseState();
    return entity;
  }

  private snapshotPilot(
    actor: GameEntity,
    tokenHash: string,
    clientReleaseId?: string
  ): PersistentPilot {
    const previous = this.pilots.get(actor.id);
    const lastClientReleaseId = readReleaseId(clientReleaseId) ?? previous?.lastClientReleaseId;
    const now = this.getServerTime();
    const flight = {
      id: actor.id,
      tokenHash,
      name: actor.name,
      score: actor.score,
      silk: actor.silk ?? 0,
      lastSeenAt: now,
      kitId: actor.kitId,
      position: { x: actor.position.x, y: actor.position.y },
      velocity: { x: actor.velocity.x, y: actor.velocity.y },
      angle: actor.angle,
      lives: actor.lives,
      mass: actor.mass,
      health: actor.health,
      boost: { ...actor.boost },
      ...releaseField('lastClientReleaseId', lastClientReleaseId),
    };
    if (previous === undefined) {
      return {
        ...flight,
        credentialReleaseId: SERVER_RELEASE_ID,
        scoreReleaseId: SERVER_RELEASE_ID,
        credentialIssuedAt: now,
        scoreUpdatedAt: now,
        ...releaseField('credentialClientReleaseId', lastClientReleaseId),
        ...releaseField('scoreClientReleaseId', lastClientReleaseId),
      };
    }
    const issuedCredential = previous.tokenHash !== tokenHash;
    const wroteScore = previous.score !== actor.score;
    return {
      ...flight,
      ...(issuedCredential
        ? {
            credentialReleaseId: SERVER_RELEASE_ID,
            credentialIssuedAt: now,
            ...releaseField('credentialClientReleaseId', lastClientReleaseId),
          }
        : {
            ...releaseField('credentialReleaseId', previous.credentialReleaseId),
            ...releaseField('credentialClientReleaseId', previous.credentialClientReleaseId),
            ...epochField('credentialIssuedAt', previous.credentialIssuedAt),
          }),
      ...(wroteScore
        ? {
            scoreReleaseId: SERVER_RELEASE_ID,
            scoreUpdatedAt: now,
            ...releaseField('scoreClientReleaseId', lastClientReleaseId),
          }
        : {
            ...releaseField('scoreReleaseId', previous.scoreReleaseId),
            ...releaseField('scoreClientReleaseId', previous.scoreClientReleaseId),
            ...epochField('scoreUpdatedAt', previous.scoreUpdatedAt),
          }),
    };
  }

  private rememberClientRelease(id: string, clientReleaseId?: string): void {
    const releaseId = readReleaseId(clientReleaseId);
    const saved = this.pilots.get(id);
    if (!saved || releaseId === undefined) {
      return;
    }
    this.setPilot({ ...saved, lastClientReleaseId: releaseId });
  }

  private writePilotScore(pilot: PersistentPilot, score: number): PersistentPilot {
    const next: PersistentPilot = {
      ...pilot,
      score,
      scoreReleaseId: SERVER_RELEASE_ID,
      scoreUpdatedAt: this.getServerTime(),
    };
    delete next.scoreClientReleaseId;
    return next;
  }

  public getPilotReleaseProvenance(id: string): {
    credentialReleaseId?: string;
    credentialClientReleaseId?: string;
    credentialIssuedAt?: number;
    scoreReleaseId?: string;
    scoreClientReleaseId?: string;
    scoreUpdatedAt?: number;
  } {
    const saved = this.pilots.get(id);
    if (!saved) {
      return {};
    }
    return {
      ...releaseField('credentialReleaseId', saved.credentialReleaseId),
      ...releaseField('credentialClientReleaseId', saved.credentialClientReleaseId),
      ...epochField('credentialIssuedAt', saved.credentialIssuedAt),
      ...releaseField('scoreReleaseId', saved.scoreReleaseId),
      ...releaseField('scoreClientReleaseId', saved.scoreClientReleaseId),
      ...epochField('scoreUpdatedAt', saved.scoreUpdatedAt),
    };
  }

  private capturePilot(id: string): void {
    const previous = this.pilots.get(id);
    const actor = this.getPlayer(id);
    if (!previous || !actor) {
      return;
    }
    this.setPilot(this.snapshotPilot(actor, previous.tokenHash));
  }

  public registerPilot(
    actor: GameEntity,
    socket: WebSocket,
    clientReleaseId?: string
  ): ReturnType<PlayerMotionService['register']> {
    const result = this.playerMotion.register(actor, socket, 1, this.getServerTime());
    if (!result.ok) {
      return result;
    }
    this.setPilot(
      this.snapshotPilot(
        actor,
        createHash('sha256').update(result.resumeToken).digest('hex'),
        clientReleaseId
      )
    );
    return result;
  }

  public hasSavedPilot(id: string): boolean {
    return this.pilots.has(id);
  }

  public resumePilot(
    token: string,
    socket: WebSocket,
    requestedKit?: ShipKitId,
    requestedName?: string,
    clientReleaseId?: string
  ): ReturnType<PlayerMotionService['resume']> {
    if (!PILOT_RESUME_TOKEN_PATTERN.test(token)) {
      return { ok: false, error: 'Invalid pilot resume token' };
    }
    const hash = createHash('sha256').update(token).digest('hex');
    let saved = [...this.pilots.values()].find((pilot) => pilot.tokenHash === hash);
    const live = this.playerMotion.resume(token, socket, this.getServerTime());
    if (live.ok && live.actor.lives > 0) {
      this.rememberClientRelease(live.actor.id, clientReleaseId);
      this.applyRequestedPilotIdentity(live.actor, requestedKit, requestedName, true);
      this.ensurePilotInOpenSector(live.actor);
      return live;
    }
    if (live.ok) {
      this.removePlayer(live.actor.id);
      saved = this.pilots.get(live.actor.id) ?? saved;
    }
    if (!saved || this.getPlayerBySocket(socket)) {
      return live;
    }
    // Expired transport grace may still own an actor until the next simulation tick.
    if (this.getPlayer(saved.id)) {
      this.removePlayer(saved.id);
      saved = this.pilots.get(saved.id) ?? saved;
    }
    const flight = restorableFlight(saved, this.getServerTime());
    const actor = this.addPlayer(
      saved.id,
      saved.name,
      socket,
      flight?.position,
      requestedKit ?? flight?.kitId
    );
    this.applyRequestedPilotIdentity(actor, undefined, requestedName, false);
    actor.score = saved.lives === 0 ? GAME.STARTING_SCORE : saved.score;
    actor.silk = saved.silk ?? 0;
    if (flight) {
      this.restoreRecentFlight(actor, flight, requestedKit);
    }
    actor.asteroidInteractions = 1;
    const registered = this.registerPilot(actor, socket, clientReleaseId);
    if (!registered.ok) {
      this.removePlayer(actor.id);
      return registered;
    }
    this.enableAsteroidInteractions(actor);
    return { ok: true, actor, resumeToken: registered.resumeToken };
  }

  private applyRequestedPilotIdentity(
    actor: GameEntity,
    requestedKit: ShipKitId | undefined,
    requestedName: string | undefined,
    invalidateMotionOnKitChange: boolean
  ): void {
    if (requestedKit && requestedKit !== actor.kitId) {
      applyShipKitStats(actor, requestedKit);
      actor.harpoonTargetId = null;
      delete actor.harpoonLatchPos;
      if (invalidateMotionOnKitChange) {
        this.playerMotion.invalidateLife(actor.id, this.getServerTime());
      }
    }
    const name = sanitizePlayerName(requestedName ?? '');
    if (!name || name === actor.name) {
      return;
    }
    const taken = this.getAllPlayers().some(
      (candidate) =>
        candidate.id !== actor.id && candidate.name.toLowerCase() === name.toLowerCase()
    );
    if (taken) {
      return;
    }
    actor.name = name;
  }

  private restoreRecentFlight(
    actor: GameEntity,
    flight: RestorableFlight,
    requestedKit: ShipKitId | undefined
  ): void {
    if (flight.boost) {
      actor.boost = { ...flight.boost };
      stopShipBoost(actor.boost);
      advanceShipBoost(actor.boost, Math.max(0, this.getServerTime() - flight.lastSeenAt));
    }
    actor.angle = flight.angle;
    actor.lives = flight.lives;
    if (!requestedKit || requestedKit === flight.kitId) {
      actor.mass = flight.mass;
      actor.health = flight.health > 0 ? Math.min(flight.health, actor.maxHealth) : actor.maxHealth;
    }
    if (flight.velocity) {
      actor.velocity = { x: flight.velocity.x, y: flight.velocity.y };
    }
    delete actor.spawnProtectionTimer;
    this.ensurePilotInOpenSector(actor);
  }

  private ensureScoreSeason(): void {
    const season = utcScoreSeason(this.getServerTime());
    if (season === this.scoreSeason) {
      return;
    }
    this.beginScoreSeason(season);
  }

  private beginScoreSeason(season: string): void {
    logger.warn('WORLD', 'Score season rolled over; resetting world and monthly scores', {
      previousScoreSeason: this.scoreSeason,
      currentScoreSeason: season,
    });
    this.scoreSeason = season;
    const now = this.getServerTime();
    this.worldStartedAt = now;
    this.persistence?.reset();
    this.regionalField.reset();
    this.exploration.reset();
    this.mapAssets.reset();
    this.completedSectors.clear();
    this.clearWorldObjects();
    this.pendingFurnaceDeliveries = [];
    for (const pilot of this.pilots.values()) {
      this.setPilot({
        id: pilot.id,
        tokenHash: pilot.tokenHash,
        name: pilot.name,
        score: 0,
        silk: pilot.silk ?? 0,
        ...releaseField('credentialReleaseId', pilot.credentialReleaseId),
        ...releaseField('credentialClientReleaseId', pilot.credentialClientReleaseId),
        ...epochField('credentialIssuedAt', pilot.credentialIssuedAt),
        scoreReleaseId: SERVER_RELEASE_ID,
        scoreUpdatedAt: now,
        ...releaseField('lastClientReleaseId', pilot.lastClientReleaseId),
      });
    }
    for (const actor of this.getAllPlayers()) {
      actor.score = 0;
    }
    this.ensureAsteroidField();
    this.checkpointWorld();
  }

  /**
   * Hand everything that changed since the last flush to persistence as one
   * batch. The batch leaves this thread without waiting on the disk; the
   * inline store used by tests commits before returning instead. While a
   * batch is still committing, the request is coalesced into one flush that
   * runs as soon as the writer is idle, so a slow disk can never queue up
   * more than one batch behind the one in flight.
   */
  public checkpointWorld(): void {
    if (this.persistenceFailure) {
      throw this.persistenceFailure;
    }
    this.ensureScoreSeason();
    if (!this.persistence) {
      return;
    }
    if (!this.persistenceIdle()) {
      this.flushWhenIdle();
      return;
    }
    try {
      for (const actor of this.getAllPlayers()) {
        this.capturePilot(actor.id);
      }
      const pilots: PersistentPilot[] = [];
      for (const id of this.dirtyPilots) {
        const pilot = this.pilots.get(id);
        if (pilot) {
          pilots.push(pilot);
        }
      }
      const worldRow = this.worldRowIfChanged();
      this.persistence.persist({
        ...(worldRow ? { world: worldRow.world } : {}),
        // Custom diagnostic belts do not belong to regional activation or sleep bookkeeping.
        sectors: this.managedField
          ? this.regionalField.checkpoint(this.asteroidManager)
          : new Map(),
        pilots,
      });
      if (worldRow) {
        this.lastFlushedWorldRow = worldRow.builtFrom;
      }
      this.dirtyPilots.clear();
      if (this.managedField) {
        this.regionalField.saved();
      }
    } catch (cause) {
      this.failPersistence(cause);
      throw this.persistenceFailure;
    }
  }

  /**
   * The world row carries the whole exploration grid, so it is only rebuilt
   * and sent when one of its inputs changed since the last flush. The
   * exploration snapshot keeps its identity until a cell is revealed, and
   * completed sectors only ever grow between resets.
   */
  private worldRowIfChanged(): { world: SavedWorld; builtFrom: FlushedWorldRow } | undefined {
    const builtFrom: FlushedWorldRow = {
      exploration: this.exploration.snapshot(),
      completedSectors: this.completedSectors.size,
      scoreSeason: this.scoreSeason,
      startedAt: this.worldStartedAt,
      asteroidDensityVersion: WORLD.asteroidDensityVersion,
      asteroidMotionVersion: WORLD.asteroidMotionVersion,
    };
    const last = this.lastFlushedWorldRow;
    if (
      last &&
      last.exploration === builtFrom.exploration &&
      last.completedSectors === builtFrom.completedSectors &&
      last.scoreSeason === builtFrom.scoreSeason &&
      last.startedAt === builtFrom.startedAt &&
      last.asteroidDensityVersion === builtFrom.asteroidDensityVersion &&
      last.asteroidMotionVersion === builtFrom.asteroidMotionVersion
    ) {
      return undefined;
    }
    return {
      world: {
        seed: this.worldSeed,
        startedAt: this.worldStartedAt,
        generation: WORLD.generation,
        asteroidDensityVersion: WORLD.asteroidDensityVersion,
        asteroidMotionVersion: WORLD.asteroidMotionVersion,
        scoreSeason: this.scoreSeason,
        writtenReleaseId: SERVER_RELEASE_ID,
        exploration: builtFrom.exploration,
        completedSectors: [...this.completedSectors].sort(),
      },
      builtFrom,
    };
  }

  /**
   * Do not continue from memory that the database no longer matches. The
   * next tick reaches the process fatal-error boundary, including while paused.
   * The first-hand reason is logged here, once, so the restart loop that
   * follows can be explained from the logs alone.
   */
  private failPersistence(cause: unknown): void {
    if (this.persistenceFailure) {
      return;
    }
    this.persistenceFailure = new Error('Persistent world checkpoint failed', { cause });
    logger.error('WORLD', 'world_persistence_failed', {
      releaseId: SERVER_RELEASE_ID,
      observedAt: this.getServerTime(),
      gameTime: this.gameTime,
      players: this.getPlayerCount(),
      persistence: this.persistence?.diagnostics(),
      error: boundedDiagnosticError(cause, 'Unknown persistence failure'),
    });
  }

  private persistenceIdle(): boolean {
    return (this.persistence?.diagnostics().pendingBatches ?? 0) === 0;
  }

  private flushWhenIdle(): void {
    if (this.flushWaitingForIdle || !this.persistence) {
      return;
    }
    this.flushWaitingForIdle = true;
    void this.persistence.whenIdle().then(() => {
      this.flushWaitingForIdle = false;
      if (this.persistenceFailure) {
        return;
      }
      try {
        this.checkpointWorld();
      } catch (error) {
        // Nothing awaits a deferred flush, so anything it throws is latched
        // here; the next tick is fatal.
        this.failPersistence(error);
      }
    });
  }

  /**
   * Resolves true once nothing is in flight: every batch handed over has been
   * committed or failed, including a flush that was waiting for the writer.
   * Resolves false if the writer is still busy when the wait runs out.
   */
  public async whenPersistenceIdle(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const deadline = globalThis.performance.now() + timeoutMs;
    while (this.persistence && (this.flushWaitingForIdle || !this.persistenceIdle())) {
      const remaining = deadline - globalThis.performance.now();
      if (!(await settledWithin(this.persistence.whenIdle(), remaining))) {
        return false;
      }
      // Let a coalesced flush that was waiting on the same idle post its batch.
      await Promise.resolve();
    }
    return true;
  }

  /**
   * Flush the final state and release the database. Call after the loop has
   * stopped and the transports have closed, so departing pilots are captured.
   * A writer that does not drain within the shutdown budget forfeits the
   * final flush: the worker is still closed on its own deadline, and the
   * skipped flush is reported so the exit is not mistaken for a clean one.
   */
  public async shutdownPersistence(): Promise<void> {
    if (!this.persistence) {
      return;
    }
    let drained = false;
    try {
      drained = await this.whenPersistenceIdle(SHUTDOWN_IDLE_WAIT_MS);
      if (drained && !this.persistenceFailure) {
        this.checkpointWorld();
      }
    } finally {
      await this.persistence.shutdown();
    }
    // A deferred flush that failed while draining latched the failure without
    // anyone awaiting it; a clean exit would misreport that.
    if (this.persistenceFailure) {
      throw this.persistenceFailure;
    }
    if (!drained) {
      throw new Error(
        `World writer did not drain within ${SHUTDOWN_IDLE_WAIT_MS} ms; the final flush was skipped`
      );
    }
  }

  private setPilot(pilot: PersistentPilot): void {
    this.pilots.set(pilot.id, pilot);
    this.dirtyPilots.add(pilot.id);
  }

  public isPersistenceHealthy(): boolean {
    return this.persistenceFailure === undefined;
  }

  public transportClosed(ws: WebSocket): boolean {
    const actor = this.entityManager.getEntityBySocket(ws);
    const closed = this.playerMotion.transportClosed(ws, this.getServerTime());
    if (closed && actor && this.cancelArmedBoost(actor.id, actor.harpoonTargetId)) {
      clearHaulerLatch(actor);
    }
    return closed;
  }

  public drainDepartedPlayers(): string[] {
    return this.departedPlayers.splice(0);
  }

  public updatePlayer(id: string, updates: Partial<GameEntity>): GameEntity | undefined {
    return this.entityManager.updateEntity(id, updates);
  }

  public getPlayer(id: string): GameEntity | undefined {
    return this.entityManager.getEntity(id);
  }

  public getPlayerBySocket(ws: WebSocket): GameEntity | undefined {
    return this.entityManager.getEntityBySocket(ws);
  }

  public getAllPlayers(): GameEntity[] {
    return this.entityManager.getAllEntities();
  }

  public getSpiderField() {
    return this.spiderManager.snapshot();
  }

  /** Deterministic arrangement hook for server scenarios and diagnostics. */
  public spawnTerrainSpider(position: Position, angle = 0) {
    return this.spiderManager.spawnSpider(position, angle);
  }

  public clearSpiderField(): void {
    this.spiderManager.clear();
    this.pendingSpiderAttacks = [];
  }

  private advanceSpiderField(): void {
    const towedIds = new Set(
      this.entityManager
        .getAllEntities()
        .filter(
          (entity) =>
            isTowCableUtility(entity) &&
            entity.harpoonTargetId &&
            !entity.exploding &&
            entity.health > 0
        )
        .map((entity) => entity.harpoonTargetId)
        .filter((id): id is string => id !== null && id !== undefined)
    );
    const previousIds = new Set(this.spiderManager.getBodies().map((spider) => spider.id));
    const attacks = this.spiderManager.advance({
      towedIds,
      players: this.entityManager.getAllEntities().map((entity) => ({
        id: entity.id,
        position: entity.position,
        health: entity.health,
        exploding: entity.exploding,
        ...(entity.respawnTimer !== undefined ? { respawnTimer: entity.respawnTimer } : {}),
        ...(entity.spawnProtectionTimer !== undefined
          ? { spawnProtectionTimer: entity.spawnProtectionTimer }
          : {}),
        radius: hullRadiusForKit(entity.kitId),
      })),
      completedSectors: this.completedSectors,
      nowFrame: this.gameTime,
      dormantResource: (id, home) => {
        const rock = this.regionalField.dormantAsteroid(id, home);
        return rock ? spiderResources([rock], [], [])[0] : undefined;
      },
      resources: () =>
        spiderResources(
          this.asteroidManager.getAllAsteroids(),
          this.lootManager.getAll(),
          this.satellitePickupManager.getAllPickups()
        ),
    });
    this.pendingSpiderAttacks.push(...attacks);
    for (const entity of this.entityManager.getAllEntities()) {
      if (
        entity.harpoonTargetId &&
        previousIds.has(entity.harpoonTargetId) &&
        !this.spiderManager.getBody(entity.harpoonTargetId)
      ) {
        clearHaulerLatch(entity);
      }
    }
  }

  public getPlayerCount(): number {
    return this.entityManager.getAllEntities().length;
  }

  /**
   * Map/schematic hold: freeze this hull, skip collisions, and blink when the
   * overlay closes. Session-only; not written to the world database.
   */
  public setOverlayHold(id: string, held: boolean): void {
    const entity = this.entityManager.getEntity(id);
    if (!entity) {
      return;
    }
    const wasHeld = entity.overlayHold === true;
    if (held) {
      entity.overlayHold = true;
      entity.velocity = { x: 0, y: 0 };
      entity.knockbackVelocityLimit = 0;
      entity.thrusting = false;
      stopShipBoost(entity.boost);
      return;
    }
    if (wasHeld) {
      entity.overlayHold = false;
      if (!entity.exploding && entity.health > 0 && entity.respawnTimer === undefined) {
        entity.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
      }
      return;
    }
    entity.overlayHold = false;
  }

  // Asteroid operations
  public addAsteroid(asteroid: AsteroidData): void {
    this.asteroidManager.addAsteroid(asteroid);
    this.surveyProbeManager.registerAsteroid(asteroid);
  }

  public removeAsteroid(asteroidId: string): AsteroidData | undefined {
    const removed = this.asteroidManager.removeAsteroid(asteroidId);
    this.surveyProbeManager.unregister(asteroidId);
    if (removed?.probe) {
      removed.probe = null;
    }
    return removed;
  }

  public updateAsteroid(
    asteroidId: string,
    updates: Partial<AsteroidData>
  ): AsteroidData | undefined {
    const updated = this.asteroidManager.updateAsteroid(asteroidId, updates);
    if (!updated) {
      return undefined;
    }
    this.surveyProbeManager.registerAsteroid(updated);
    return updated;
  }

  public getAsteroid(asteroidId: string): AsteroidData | undefined {
    return this.asteroidManager.getAsteroid(asteroidId);
  }

  public getAllAsteroids(): AsteroidData[] {
    return this.asteroidManager.getAllAsteroids();
  }

  /** Seed the always-on asteroid interaction field for the active arena. */
  public enableAsteroidInteractions(player: GameEntity): void {
    player.asteroidInteractions = 1;
    this.seedAsteroidInteractions();
  }

  private seedAsteroidInteractions(): void {
    if (this.managedField) {
      return;
    }
    const rocks = this.getAllAsteroids();
    const firstRock = rocks[0];
    if (!firstRock) {
      return;
    }
    if (!this.decoratedFieldId) {
      seedAsteroidPhenomena(rocks);
      this.decoratedFieldId = firstRock.id;
    }
  }

  public getPlayerProjectiles(): PlayerProjectileState[] {
    return this.lasers
      .filter((laser) => !laser.hasExploded)
      .map((laser) => ({
        id: laser.id,
        ownerId: laser.ownerId,

        position: { ...laser.position },
        prevPosition: { ...laser.prevPosition },
        velocity: { ...laser.velocity },
        energy: laser.energy,
        bounces: laser.bounces,
        age: laser.age,
      }));
  }

  public drainShotSounds(): PlayerShotFired[] {
    return this.pendingShotSounds
      .splice(0)
      .map(({ laser, position }) => ({ id: laser.id, ownerId: laser.ownerId, position }));
  }

  public drainLootCollections(): LootCollected[] {
    return this.pendingLootCollections.splice(0);
  }

  public drainTapEjections(): TapEjected[] {
    return this.pendingTapEjections.splice(0);
  }

  public drainLootBlasts() {
    return this.pendingLootBlasts.splice(0);
  }

  public getAsteroidCount(): number {
    return this.asteroidManager.getAsteroidCount();
  }

  /**
   * Activate nearby sectors, preserving depleted and previously visited regions.
   * Return newly loaded rows so joining pilots can receive them immediately.
   */
  public ensureAsteroidField(): AsteroidData[] {
    if (this.isPaused || this.getPlayerCount() === 0) {
      return [];
    }
    if (!this.managedField) {
      return [];
    }
    const created = this.regionalField.update(
      this.asteroidManager,
      [
        ...this.entityManager.getAllEntities().map((entity) => entity.position),
        ...this.surveyProbeManager.observerPositions(),
      ],
      this.completedSectors
    );
    this.seedAsteroidInteractions();
    return created;
  }

  public createAsteroids(
    count: number,
    bounds = { radius: getAsteroidFieldRadius() },
    playerPositions: Array<{ x: number; y: number }> = []
  ): AsteroidData[] {
    this.managedField = false;
    return this.asteroidManager.createAsteroids(count, bounds, playerPositions);
  }

  /** Snapshot source for the server-owned collaborative hit window. */
  public getActiveCollabTags(now = this.getServerTime()): ActiveCollabTag[] {
    return this.asteroidManager.getActiveCollabTags(now);
  }

  public getSatellitePickup(pickupId: string): SatellitePickupData | undefined {
    return this.satellitePickupManager.getAllPickups().find((pickup) => pickup.id === pickupId);
  }

  public getAllSatellitePickups(): SatellitePickupData[] {
    return this.satellitePickupManager.getAllPickups();
  }

  public getSatellitePickupCount(): number {
    return this.satellitePickupManager.getCount();
  }

  /** Park live pickups far from a test corridor so they cannot intercept shots. */
  public parkSatellitePickups(position: Position = { x: 20_000, y: 20_000 }): void {
    for (const snapshot of this.satellitePickupManager.getAllPickups()) {
      const pickup = this.satellitePickupManager.getPickup(snapshot.id);
      if (!pickup || pickup.state === 'broken') {
        continue;
      }
      pickup.position = { ...position };
      pickup.velocity = { x: 0, y: 0 };
      pickup.ownerId = null;
      if (pickup.state === 'orbiting' || pickup.state === 'stored') {
        pickup.state = 'loose';
      }
    }
  }

  /** Keep the pickup field alive for every active arena. */
  public ensureSatellitePickups(): SatellitePickupData[] {
    if (this.isPaused || this.getPlayerCount() === 0) {
      return [];
    }
    if (this.satellitePickupManager.getCount() > 0) {
      return [];
    }
    return this.satellitePickupManager.createPickups();
  }

  public tickSatellitePickups(): SatellitePickupData[] {
    if (this.isPaused) {
      return this.getAllSatellitePickups();
    }
    const owners = this.entityManager.getAllEntities().map((entity) => ({
      id: entity.id,
      position: entity.position,
      radius: hullRadiusForKit(entity.kitId),
      health: entity.health,
      exploding: entity.exploding,
    }));
    this.satellitePickupManager.update(owners);
    this.collectNearbySatellitePickups();
    return this.getAllSatellitePickups();
  }

  public equipSatellite(entityId: string, pickupId: string): boolean {
    const owner = this.entityManager.getEntity(entityId);
    if (!owner || owner.respawnTimer !== undefined || this.isPaused) {
      return false;
    }
    return (
      this.satellitePickupManager.equip(pickupId, {
        id: owner.id,
        position: owner.position,
        radius: hullRadiusForKit(owner.kitId),
        health: owner.health,
        exploding: owner.exploding,
      }) !== null
    );
  }

  private collectNearbySatellitePickups(): void {
    const players = this.entityManager
      .getAllEntities()
      .filter(
        (entity) =>
          entity.health > 0 &&
          !entity.exploding &&
          entity.respawnTimer === undefined &&
          entity.overlayHold !== true
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    const loosePickups = this.satellitePickupManager
      .getAllPickups()
      .filter((pickup) => pickup.state === 'loose' && pickup.health > 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const pickup of loosePickups) {
      const collector = players
        .map((entity) => ({
          entity,
          distance: Math.hypot(
            pickup.position.x - entity.position.x,
            pickup.position.y - entity.position.y
          ),
        }))
        .filter(({ distance }) => distance <= SATELLITE_PICKUP.AUTO_COLLECT_RANGE)
        .sort(
          (a, b) => a.distance - b.distance || a.entity.id.localeCompare(b.entity.id)
        )[0]?.entity;
      if (!collector) {
        continue;
      }

      const collected = this.satellitePickupManager.collect(pickup.id, {
        id: collector.id,
        position: collector.position,
        radius: hullRadiusForKit(collector.kitId),
        health: collector.health,
        exploding: collector.exploding,
      });
      if (!collected) {
        continue;
      }

      collector.score += SATELLITE_PICKUP.SCORE_BONUS;
      collector.lastUpdate = this.getServerTime();
      this.queueSatellitePickupCollected({
        position: { ...pickup.position },
        pickupId: collected.id,
        playerId: collector.id,
        playerName: collector.name,
        pickupName: collected.name,
        scoreBonus: SATELLITE_PICKUP.SCORE_BONUS,
      });
    }
  }

  private queueSatellitePickupCollected(event: SatellitePickupCollected): void {
    if (this.pendingSatellitePickupCollections.length >= MAX_PENDING_SATELLITE_PICKUP_EVENTS) {
      this.pendingSatellitePickupCollections.shift();
    }
    this.pendingSatellitePickupCollections.push(event);
  }

  public drainSatellitePickupCollections(): SatellitePickupCollected[] {
    const events = this.pendingSatellitePickupCollections;
    this.pendingSatellitePickupCollections = [];
    return events;
  }

  /** Apply one authoritative physical hit to a live satellite pickup. */
  public handleSatellitePickupDamage(pickupId: string, damage: number): SatellitePickupData | null {
    return this.satellitePickupManager.damage(pickupId, damage);
  }

  /**
   * Apply damage through one path. Protection, loot, and deathCause stay on
   * the tip helpers; health/lives stay server-owned.
   */
  public handleShipDamage(
    targetId: string,
    attackerId: string,
    damage: number
  ): { applied: boolean; isDestroyed: boolean; entity?: GameEntity } {
    logger.debug('handleShipDamage called', { targetId, attackerId, damage });
    // Direct crew shots and rams never apply. World hazards, including bounced
    // lasers, still remove health.
    if (!isWorldHazard(attackerId)) {
      return { applied: false, isDestroyed: false };
    }

    const existing = this.entityManager.getEntity(targetId);
    if (!existing) {
      return { applied: false, isDestroyed: false };
    }
    if (isCombatantImmune(existing)) {
      return { applied: false, isDestroyed: false };
    }

    const healthBefore = existing.health;
    const livesBefore = existing.lives;
    const damaged = this.entityManager.damageEntity(targetId, damage);
    if (!damaged) {
      return { applied: false, isDestroyed: false };
    }

    if (damaged.health > 0) {
      if (damaged.health < healthBefore) {
        this.logDamageState(damaged, attackerId, damage, healthBefore, livesBefore, false);
      }
      return { applied: true, isDestroyed: false, entity: damaged };
    }

    this.applyShipDeath(damaged, attackerId);
    this.logDamageState(damaged, attackerId, damage, healthBefore, livesBefore, true);
    return { applied: true, isDestroyed: true, entity: damaged };
  }

  private logDamageState(
    entity: GameEntity,
    attackerId: string,
    damage: number,
    healthBefore: number,
    livesBefore: number,
    destroyed: boolean
  ): void {
    const observedAt = Date.now();
    const throttleAt = this.getServerTime();
    const lastThrottleAt = this.damageStateLogs.get(entity) ?? -Infinity;
    if (!destroyed && throttleAt - lastThrottleAt < 1000) {
      return;
    }
    this.damageStateLogs.set(entity, throttleAt);
    logger.info('STATE', destroyed ? 'player_died' : 'damage_applied', {
      releaseId: SERVER_RELEASE_ID,
      playerId: entity.id,
      attackerId,
      source: 'collision',
      damage,
      observedAt,
      gameTime: this.gameTime,
      healthBefore,
      healthAfter: entity.health,
      livesBefore,
      livesAfter: entity.lives,
      state: captureDiagnosticActorState(entity),
    });
  }

  private logRespawns(ids: readonly string[]): void {
    for (const playerId of ids) {
      const entity = this.entityManager.getEntity(playerId);
      if (!entity) {
        continue;
      }
      this.ensurePilotInOpenSector(entity);
      logger.info('STATE', 'player_respawned', {
        releaseId: SERVER_RELEASE_ID,
        playerId,
        observedAt: Date.now(),
        gameTime: this.gameTime,
        state: captureDiagnosticActorState(entity),
      });
    }
  }

  /**
   * Server-owned ship and asteroid resolution. Asteroid motion already ran in
   * the game loop (`updateMotion`); this only applies health. Ram uses the tip
   * collision destroy path so laser collab stays intact.
   */
  public resolveAuthoritativeCombat(): CombatBroadcast[] {
    if (this.isPaused) {
      return [];
    }

    const results: CombatBroadcast[] = [];
    const entities = this.entityManager.getAllEntities();
    for (const entity of entities) {
      const radius = hullRadiusForKit(entity.kitId);
      if (
        checkBoundaryCollision(entity.position, radius) ||
        shipOverlapsCompletedSector(entity.position, radius, this.completedSectors)
      ) {
        const result = this.applyDirectedHit(entity.id, 'boundary', entity.health);
        if (result) {
          results.push(result);
        }
      }
    }

    const asteroids = this.asteroidManager
      .getAllAsteroids()
      .filter((rock) => rock.boost?.phase !== 'burning');
    const pickupBodyHits = this.collisionAuthority.collectAsteroidPickupHits(
      asteroids,
      this.satellitePickupManager.getAllPickups()
    );
    for (const hit of pickupBodyHits) {
      this.handleSatellitePickupDamage(hit.pickupId, DAMAGE.LASER_HIT);
    }

    const ramHits = this.collisionAuthority.collectShipAsteroidHits(
      entities,
      asteroids,
      (shipId, asteroidId) => this.isActiveHarpoonTarget(shipId, asteroidId)
    );
    const destroyedAsteroids = new Set<string>();
    const bumperKeys = this.resolveTowedAsteroidImpacts(entities, asteroids, destroyedAsteroids);
    for (const hit of ramHits) {
      if (bumperKeys.has(`${hit.shipId}:${hit.asteroidId}`)) {
        continue;
      }
      const result = this.applyDirectedHit(hit.shipId, 'asteroid', DAMAGE.ASTEROID_COLLISION);
      if (!result) {
        continue;
      }
      if (!destroyedAsteroids.has(hit.asteroidId)) {
        const destruction = this.handleAsteroidHit(hit.asteroidId, hit.shipId, 'collision');
        if (destruction.outcome === 'destroyed') {
          destroyedAsteroids.add(hit.asteroidId);
          result.destroyedAsteroidId = hit.asteroidId;
          result.newAsteroids = destruction.newAsteroids;
          // Rubble has its own ordinary three-fragment break. Keep the
          // cooperative shockwave reserved for the collaborative split path,
          // even if a future collision destroyer starts returning fragments.
          result.collabSplit = destruction.split && destruction.destroyed?.material !== 'rubble';
          if (destruction.destroyed) {
            result.origin = destruction.destroyed.position;
          }
          const scorer = this.entityManager.getEntity(hit.shipId);
          if (scorer) {
            result.asteroidScore = { playerId: hit.shipId, score: scorer.score };
          }
        }
      }
      const remaining = this.asteroidManager.getAsteroid(hit.asteroidId);
      const rammed = this.entityManager.getEntity(hit.shipId);
      if (remaining && rammed) {
        separateShipFromAsteroid(rammed, hullRadiusForKit(rammed.kitId), remaining);
        this.playerMotion.applyExternalImpulse(rammed.id, this.getServerTime());
      }
      results.push(result);
    }

    for (const attack of this.pendingSpiderAttacks.splice(0)) {
      if (!this.spiderManager.isAttackActive(attack)) {
        continue;
      }
      const target = this.entityManager.getEntity(attack.targetId);
      if (!target) {
        continue;
      }
      const result = this.applyDirectedHit(attack.targetId, attack.attackerId, target.health);
      if (result) {
        results.push(result);
      }
    }

    for (const result of results) {
      this.combatSink?.(result);
    }
    return results;
  }

  /** An active Hauler harpoon lets its owner pass through that exact rock. */
  private isActiveHarpoonTarget(shipId: string, asteroidId: string): boolean {
    const ship = this.entityManager.getEntity(shipId);
    return ship?.kitId === 'hauler' && ship.harpoonTargetId === asteroidId;
  }

  /**
   * Towed cargo that overlaps another rock uses the ordinary collision break
   * on both bodies and drops the cable. The Hauler is not rammed by a rock
   * its cargo is already breaking this frame.
   */
  private resolveTowedAsteroidImpacts(
    entities: GameEntity[],
    asteroids: AsteroidData[],
    destroyedAsteroids: Set<string>
  ): Set<string> {
    const towedOwners = new Map<string, string[]>();
    const towedRocks: AsteroidData[] = [];
    for (const entity of entities) {
      if (entity.kitId !== 'hauler' || !isTowCableUtility(entity) || !entity.harpoonTargetId) {
        continue;
      }
      const rock = this.asteroidManager.getAsteroid(entity.harpoonTargetId);
      if (!rock || rock.health <= 0) {
        continue;
      }
      const owners = towedOwners.get(rock.id);
      if (owners) {
        owners.push(entity.id);
      } else {
        towedOwners.set(rock.id, [entity.id]);
        towedRocks.push(rock);
      }
    }
    const bumperKeys = new Set<string>();
    const cargoBreaks: AppliedAsteroidHit[] = [];
    for (const hit of this.collisionAuthority.collectTowedAsteroidHits(towedRocks, asteroids)) {
      const haulerIds = towedOwners.get(hit.towedId);
      if (!haulerIds?.length) {
        continue;
      }
      for (const haulerId of haulerIds) {
        bumperKeys.add(`${haulerId}:${hit.otherId}`);
      }
      for (const otherHaulerId of towedOwners.get(hit.otherId) ?? []) {
        bumperKeys.add(`${otherHaulerId}:${hit.towedId}`);
      }
      const scorerId = haulerIds[0];
      if (!scorerId) {
        continue;
      }
      for (const asteroidId of [hit.towedId, hit.otherId]) {
        if (destroyedAsteroids.has(asteroidId)) {
          continue;
        }
        const applied = this.applyLaserAsteroidHit(asteroidId, scorerId, 'collision');
        if (!applied.applied || applied.outcome !== 'destroyed') {
          continue;
        }
        destroyedAsteroids.add(asteroidId);
        cargoBreaks.push(applied);
      }
    }
    this.emitAsteroidHits(cargoBreaks);
    return bumperKeys;
  }

  private releaseTowsAttachedTo(asteroidId: string): void {
    for (const player of this.entityManager.getAllEntities()) {
      if (player.harpoonTargetId === asteroidId) {
        clearHaulerLatch(player);
      }
    }
  }

  private applyDirectedHit(
    targetId: string,
    attackerId: string,
    damage: number
  ): CombatBroadcast | null {
    const outcome = this.handleShipDamage(targetId, attackerId, damage);
    if (!outcome.applied || !outcome.entity) {
      return null;
    }
    const broadcast: CombatBroadcast = {
      targetId,
      attackerId,
      damage,
      remainingHealth: outcome.entity.health,
      remainingLives: outcome.entity.lives,
      isDestroyed: outcome.isDestroyed,
      targetType: outcome.entity.type,
    };
    return broadcast;
  }

  private applyRicochetHullHit(targetId: string, damage: number): void {
    const result = this.applyDirectedHit(targetId, 'ricochet', damage);
    if (result) {
      this.combatSink?.(result);
    }
  }

  /** One death path: loot, lives, and shared respawn. */
  private applyShipDeath(entity: GameEntity, attackerId: string): void {
    if (attackerId) {
      entity.deathCause = attackerId;
    }
    this.cancelArmedBoost(entity.id, entity.harpoonTargetId);
    this.playerMotion.invalidateLife(entity.id, this.getServerTime());
    delete entity.laserUpgrade;
    this.satellitePickupManager.releaseOwner(entity.id);
    this.lootManager.spawnFromKill(entity, this.gameTime);
    entity.lives = Math.max(0, entity.lives - 1);
    if (entity.lives === 0) {
      entity.score = GAME.STARTING_SCORE;
    }
    this.entityManager.scheduleShipRespawn(entity);
  }

  private miningDamage(playerId: string): number {
    const kitId = this.entityManager.getEntity(playerId)?.kitId;
    return DAMAGE.LASER_HIT * (kitId === 'hauler' ? SHIP_ABILITY.ASTEROID_DAMAGE_MULTIPLIER : 1);
  }

  public handleAsteroidHit(
    asteroidId: string,
    playerId: string,
    cause: AsteroidHitCause = 'laser',
    now = this.getServerTime(),
    miningDamage = this.miningDamage(playerId)
  ): AsteroidHitOutcome {
    const result =
      cause === 'collision'
        ? this.asteroidManager.destroyFromCollision(asteroidId)
        : this.asteroidManager.registerLaserHit(asteroidId, playerId, now, miningDamage);

    if (result.outcome === 'destroyed' && result.destroyed) {
      this.releaseTowsAttachedTo(asteroidId);
      const points = pointsForRoidSize(result.destroyed.size);
      this.awardMiningPoints(
        playerId,
        points,
        result.contributors ?? [],
        result.destroyed.surveyedBy ?? []
      );
      this.dropShardAt(result.destroyed.position, asteroidShardMass(result.destroyed.material));

      if (result.destroyed.phenomenon?.kind === 'reflective') {
        this.lootManager.spawnLaserCore(result.destroyed.position, this.gameTime);
      }
    }
    return result;
  }

  /** Sole apply path for authoritative laser and ram outcomes. */
  public applyLaserAsteroidHit(
    asteroidId: string,
    playerId: string,
    cause: AsteroidHitCause = 'laser',
    now = this.getServerTime(),
    miningDamage = this.miningDamage(playerId)
  ): AppliedAsteroidHit {
    const empty: AppliedAsteroidHit = {
      applied: false,
      outcome: 'missing',
      asteroidId,
      playerId,
      points: 0,
      newAsteroids: [],
      split: false,
    };

    const asteroid = this.asteroidManager.getAsteroid(asteroidId);
    if (!asteroid) {
      return empty;
    }

    const result = this.handleAsteroidHit(asteroidId, playerId, cause, now, miningDamage);
    if (result.outcome === 'missing' || result.outcome === 'ignored') {
      return { ...empty, outcome: result.outcome };
    }

    const origin = result.destroyed?.position ?? asteroid.position;

    return {
      applied: true,
      outcome: result.outcome,
      asteroidId,
      playerId,
      points: result.destroyed ? pointsForRoidSize(result.destroyed.size) : 0,
      newAsteroids: result.newAsteroids,
      // The wire flag activates the cooperative shockwave. Ordinary mineral
      // fragments still broadcast through newAsteroids without that reward.
      split: result.split && asteroid.material !== 'rubble' && !isColossalAsteroid(asteroid.size),
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      origin,
    };
  }

  public flushExpiredCollabHits(now = this.getServerTime()): ExpiredCollabHit[] {
    const expired = this.asteroidManager.expireStaleHits(now);
    for (const item of expired) {
      this.releaseTowsAttachedTo(item.destroyed.id);
      this.awardMiningPoints(item.playerId, item.points, item.contributors, []);
      this.dropShardAt(item.destroyed.position, asteroidShardMass(item.destroyed.material));
    }
    this.resolvedCollabHits.push(...expired);
    return expired;
  }

  public drainResolvedCollabHits(): ExpiredCollabHit[] {
    const items = this.resolvedCollabHits;
    this.resolvedCollabHits = [];
    return items;
  }

  public setOnAsteroidHits(listener: (hits: AppliedAsteroidHit[]) => void): void {
    this.onAsteroidHits = listener;
    if (this.pendingAsteroidHits.length > 0) {
      listener(this.pendingAsteroidHits.splice(0));
    }
  }

  /**
   * Untrusted player wire entry point. Tests use spawnLaser for server-authored shots.
   * Aim remains client-predicted, but ownership alone is not proof of a valid muzzle.
   */
  public spawnPlayerLaser(
    ownerId: string,
    start: Position,
    velocity: Velocity,
    now = this.getServerTime()
  ): ServerLaser | null {
    const shooter = this.entityManager.getEntity(ownerId);
    if (
      !shooter ||
      shooter.health <= 0 ||
      shooter.exploding ||
      shooter.respawnTimer !== undefined ||
      !Number.isFinite(now) ||
      !Number.isFinite(start?.x) ||
      !Number.isFinite(start?.y) ||
      !Number.isFinite(velocity?.x) ||
      !Number.isFinite(velocity?.y) ||
      !Number.isFinite(shooter.position.x) ||
      !Number.isFinite(shooter.position.y) ||
      !Number.isFinite(shooter.velocity.x) ||
      !Number.isFinite(shooter.velocity.y)
    ) {
      return null;
    }
    const kit = getShipKit(shooter.kitId);
    // Pose velocity is sampled before the client's final movement step. Use
    // that same slope sample so a downhill shot is not rejected on flatter ground.
    const maxShipSpeed = Math.max(
      this.playerMotion.legalSpeed(shooter, now),
      this.playerMotion.legalSpeed(shooter, now, shooter.boost.phase === 'active', {
        x: shooter.position.x - shooter.velocity.x,
        y: shooter.position.y - shooter.velocity.y,
      })
    );
    const maxLaserSpeed = maxShipSpeed + LASER.SPEED / GAME.FPS;
    const muzzleRadius = (4 / 3) * hullRadiusForKit(shooter.kitId);
    const maxOriginDistance =
      muzzleRadius +
      PLAYER_SHOOT_MUZZLE_SLOP +
      maxShipSpeed * GAME.FPS * (PLAYER_SHOOT_POSE_ALLOWANCE_MS / 1000);
    if (
      Math.hypot(start.x - shooter.position.x, start.y - shooter.position.y) > maxOriginDistance ||
      // Match pose validation tolerance for floating-point mass-scaled caps.
      Math.hypot(velocity.x, velocity.y) > maxLaserSpeed + 1e-6 ||
      Math.hypot(shooter.velocity.x, shooter.velocity.y) > maxShipSpeed + 1e-6
    ) {
      return null;
    }
    // Sustained fire follows the kit cooldown.
    const previous = this.shootBudgets.get(shooter);
    const rate = 1 / kit.shotCooldown;
    const available = previous
      ? Math.min(SHIP.MAX_LASERS, previous.tokens + Math.max(0, now - previous.at) * rate)
      : SHIP.MAX_LASERS;
    if (available < 1) {
      return null;
    }
    const laser = this.spawnLaser(ownerId, start, velocity, now);
    if (!laser) {
      return null;
    }
    this.shootBudgets.set(shooter, { tokens: available - 1, at: now });
    this.laserExpiry.set(laser, now + PLAYER_LASER_MAX_LIFETIME_MS);
    return laser;
  }

  /** Spawn a simulated shot for a player `shoot` or a server-authored test. */
  public spawnLaser(
    ownerId: string,
    start: Position,
    velocity: Velocity,
    now = this.getServerTime()
  ): ServerLaser | null {
    const position = this.validatePosition(start);
    const vx = typeof velocity?.x === 'number' && Number.isFinite(velocity.x) ? velocity.x : NaN;
    const vy = typeof velocity?.y === 'number' && Number.isFinite(velocity.y) ? velocity.y : NaN;
    if (
      !position ||
      Math.hypot(position.x, position.y) > getAsteroidFieldRadius() ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy)
    ) {
      return null;
    }

    this.laserSeq += 1;
    const owner = this.getPlayer(ownerId);
    const laser: ServerLaser = {
      id: `server-laser-${this.laserNonce}-${ownerId}-${this.laserSeq}`,
      ownerId,
      miningDamage: this.miningDamage(ownerId),
      position: { x: position.x, y: position.y },
      prevPosition: { x: position.x, y: position.y },
      velocity: { x: vx, y: vy },
      distTraveled: 0,
      hasExploded: false,
      energy: 1,
      bounces: 0,
      age: 0,
    };
    if (owner?.laserUpgrade && owner.laserUpgrade.expiresAt <= now) {
      delete owner.laserUpgrade;
    }
    if (
      owner?.laserUpgrade &&
      owner.laserUpgrade.expiresAt > now &&
      owner.laserUpgrade.charges > 0
    ) {
      laser.energy = 2;
      owner.laserUpgrade.charges--;
      if (owner.laserUpgrade.charges === 0) {
        delete owner.laserUpgrade;
      }
    }
    this.lasers.push(laser);
    // Match bounded event queues; ability rings get their own single activation cue.
    if (this.pendingShotSounds.length >= 256) {
      this.pendingShotSounds.shift();
    }
    this.pendingShotSounds.push({ laser, position: { ...position } });
    return laser;
  }

  public getServerLasers(): readonly ServerLaser[] {
    return this.lasers;
  }

  /** Move live lasers and apply at most one break per asteroid / laser. */
  public advanceLasersAndResolveHits(now = this.getServerTime()): AppliedAsteroidHit[] {
    const hits: AppliedAsteroidHit[] = [];
    if (this.lasers.length === 0) {
      return hits;
    }
    const index = new AsteroidSpatialIndex(
      this.getAllAsteroids().filter((rock) => rock.boost?.phase !== 'burning')
    );

    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined) {
        continue;
      }
      if (laser.hasExploded || now >= (this.laserExpiry.get(laser) ?? Infinity)) {
        this.lasers.splice(i, 1);
        continue;
      }

      laser.age++;
      if (laser.age > ASTEROID_INTERACTIONS.maxLaserFrames) {
        this.lasers.splice(i, 1);
        continue;
      }
      laser.prevPosition = { x: laser.position.x, y: laser.position.y };
      laser.position = {
        x: laser.position.x + laser.velocity.x,
        y: laser.position.y + laser.velocity.y,
      };
      laser.distTraveled += getVelocityMagnitude(laser.velocity);

      if (laser.distTraveled >= SERVER_LASER_MAX_DISTANCE) {
        this.lasers.splice(i, 1);
        continue;
      }

      const hit = this.resolveEnhancedLaser(laser, now, index);
      if (hit) {
        hits.push(hit);
        for (const fragment of hit.newAsteroids) {
          index.add(fragment);
        }
      }
      if (laser.hasExploded) {
        this.lasers.splice(i, 1);
      }
    }

    return hits;
  }

  /** Resolve only the new muzzle overlap, never replay an older shot's swept
   * path. After a reflection, its start/end chord is not its traveled path. */
  public resolveSpawnedLaserHits(
    laserId: string,
    now = this.getServerTime()
  ): AppliedAsteroidHit[] {
    const index = this.lasers.findIndex((candidateLaser) => candidateLaser.id === laserId);
    const laser = this.lasers[index];
    if (!laser || laser.hasExploded || laser.age !== 0) {
      return [];
    }
    const hit = this.resolveEnhancedLaser(
      laser,
      now,
      new AsteroidSpatialIndex(this.getAllAsteroids())
    );
    if (laser.hasExploded) {
      this.lasers.splice(index, 1);
    }
    return hit ? [hit] : [];
  }

  private laserSegmentTargets(
    target: LaserAuxiliaryTarget,
    segmentStart: Position,
    segmentEnd: Position,
    segmentDistance: number
  ) {
    const fraction = segmentCircleContact(segmentStart, segmentEnd, target.position, target.radius);
    return fraction === undefined ? [] : [{ ...target, distance: fraction * segmentDistance }];
  }

  /** Resolve mining shots against nearby world objects; unbounced shots ignore hulls. */
  private resolveEnhancedLaser(
    laser: ServerLaser,
    now: number,
    index: AsteroidSpatialIndex
  ): AppliedAsteroidHit | null {
    let start = { ...laser.prevPosition };
    let end = { ...laser.position };
    const cargo = new Set(
      this.entityManager.getAllEntities().map((actor) => actor.harpoonTargetId)
    );
    for (let work = 0; work <= ASTEROID_INTERACTIONS.maxBounces; work++) {
      const nearbyRocks = index
        .query({
          minX: Math.min(start.x, end.x) - SURVEY_PROBE.RADIUS * 2,
          minY: Math.min(start.y, end.y) - SURVEY_PROBE.RADIUS * 2,
          maxX: Math.max(start.x, end.x) + SURVEY_PROBE.RADIUS * 2,
          maxY: Math.max(start.y, end.y) + SURVEY_PROBE.RADIUS * 2,
        })
        .filter((nearbyRock) => this.getAsteroid(nearbyRock.id) === nearbyRock);
      const rocks = nearbyRocks.filter((nearbyRock) => !cargo.has(nearbyRock.id));
      const impact = findNearestAsteroidImpact(start, end, rocks, laser.lastAsteroidId);
      const worldWall = findWorldBoundaryImpact(start, end);
      const sectorWall = findSectorWallImpact(start, end, this.completedSectors);
      const boundary =
        worldWall && sectorWall
          ? worldWall.distance <= sectorWall.distance
            ? worldWall
            : sectorWall
          : (worldWall ?? sectorWall);
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const owner = this.getPlayer(laser.ownerId);
      const hulls = laserDamagesShips(laser.bounces)
        ? this.entityManager
            .getAllEntities()
            .filter((entity) => !isCombatantImmune(entity))
            .map((entity) => ({
              id: entity.id,
              position: entity.position,
              radius: hullRadiusForKit(entity.kitId) + LASER.HIT_RADIUS,
              kind: 'ship' as const,
            }))
        : [];
      const probeTargets: LaserAuxiliaryTarget[] = this.surveyProbeManager
        .targetsIn([...nearbyRocks, ...this.spiderManager.getBodies()])
        .map((target) => ({ ...target, kind: 'surveyProbe' as const }));
      const auxiliaryTargets: LaserAuxiliaryTarget[] = [
        ...probeTargets,
        ...this.satellitePickupManager
          .getAllPickups()
          .filter(
            (pickup) =>
              pickup.state === 'orbiting' && pickup.health > 0 && laserDamagesShips(laser.bounces)
          )
          .map((pickup) => ({
            id: pickup.id,
            position: pickup.position,
            radius: pickup.radius,
            ...(pickup.ownerId === null ? {} : { ownerId: pickup.ownerId }),
            kind: 'satellitePickup' as const,
          })),
        ...this.getLoot()
          .filter((loot) => owner && inLootArmRange(owner.position, loot.position))
          .map((loot) => ({
            id: loot.id,
            position: loot.position,
            radius: loot.radius,
            kind: 'loot' as const,
          })),
        ...hulls,
      ];
      const auxiliaryHits: Array<LaserAuxiliaryTarget & { distance: number }> = [];
      for (const target of auxiliaryTargets) {
        auxiliaryHits.push(...this.laserSegmentTargets(target, start, end, distance));
      }
      const auxiliary = auxiliaryHits.sort(
        (a, b) => a.distance - b.distance || a.id.localeCompare(b.id)
      )[0];
      const spiderHit = this.spiderManager.findLaserHit(start, end);
      if (
        auxiliary &&
        (!spiderHit || auxiliary.distance <= spiderHit.distance) &&
        (!impact ||
          auxiliary.distance < impact.distance ||
          (auxiliary.distance === impact.distance && auxiliary.kind === 'surveyProbe')) &&
        (!boundary || auxiliary.distance < boundary.distance)
      ) {
        laser.hasExploded = true;
        if (auxiliary.kind === 'satellitePickup') {
          this.handleSatellitePickupDamage(auxiliary.id, DAMAGE.LASER_HIT * laser.energy);
        } else if (auxiliary.kind === 'loot') {
          const blast = this.handleLootExplode(laser.ownerId, auxiliary.id);
          if (blast.success && blast.origin) {
            this.pendingLootBlasts.push({
              lootId: auxiliary.id,
              position: { ...blast.origin },
              radius: LOOT_BLAST.RADIUS,
              shooterId: laser.ownerId,
            });
          }
        } else if (auxiliary.kind === 'surveyProbe') {
          this.damageSurveyProbe(auxiliary.hostId, DAMAGE.LASER_HIT * laser.energy);
        } else {
          this.applyRicochetHullHit(auxiliary.id, DAMAGE.LASER_HIT * laser.energy);
        }
        return null;
      }
      if (
        spiderHit &&
        (!auxiliary || spiderHit.distance < auxiliary.distance) &&
        (!impact || spiderHit.distance < impact.distance) &&
        (!boundary || spiderHit.distance < boundary.distance)
      ) {
        this.spiderManager.resolveLaserHit(start, end, DAMAGE.LASER_HIT * laser.energy);
        laser.hasExploded = true;
        return null;
      }
      if (boundary && (!impact || boundary.distance <= impact.distance)) {
        if (laser.bounces >= ASTEROID_INTERACTIONS.maxBounces) {
          laser.hasExploded = true;
          return null;
        }
        laser.velocity = reflectVector(laser.velocity, boundary.normal);
        laser.bounces++;
        delete laser.lastAsteroidId;
        const speed = getVelocityMagnitude(laser.velocity);
        const remaining = Math.max(0, distance - boundary.distance);
        start = {
          x: boundary.point.x - boundary.normal.x * 1e-5,
          y: boundary.point.y - boundary.normal.y * 1e-5,
        };
        end = {
          x: start.x + (laser.velocity.x / speed) * remaining,
          y: start.y + (laser.velocity.y / speed) * remaining,
        };
        laser.prevPosition = { ...start };
        continue;
      }
      if (!impact) {
        laser.position = end;
        return null;
      }
      const rock = this.getAsteroid(impact.asteroidId);
      if (!rock) {
        return null;
      }
      laser.position = { ...impact.point };
      if (rock.phenomenon?.kind === 'reflective') {
        this.asteroidManager.recordMiningHit(rock.id, laser.ownerId);
        const charge = advanceReflectionEnergy(
          rock.phenomenon.energy,
          rock.phenomenon.maxEnergy,
          laser.energy,
          laser.bounces
        );
        rock.phenomenon.energy = charge.asteroidEnergy;
        if (!charge.reflects) {
          const result = this.handleAsteroidHit(rock.id, laser.ownerId, 'collision');
          laser.hasExploded = true;
          return {
            applied: result.outcome === 'destroyed',
            outcome: result.outcome,
            asteroidId: rock.id,
            playerId: laser.ownerId,
            points: pointsForRoidSize(rock.size),
            newAsteroids: result.newAsteroids,
            split: false,
            origin: { ...rock.position },
          };
        }
        laser.velocity = reflectVector(laser.velocity, impact.normal);
        laser.energy = charge.laserEnergy;
        laser.bounces++;
        laser.lastAsteroidId = rock.id;
        const speed = Math.hypot(laser.velocity.x, laser.velocity.y);
        if (speed <= 1e-9) {
          laser.hasExploded = true;
          return null;
        }
        const remaining = Math.max(0, distance - impact.distance);
        const direction = { x: laser.velocity.x / speed, y: laser.velocity.y / speed };
        start = { x: impact.point.x + direction.x * 1e-5, y: impact.point.y + direction.y * 1e-5 };
        end = { x: start.x + direction.x * remaining, y: start.y + direction.y * remaining };
        continue;
      }
      laser.hasExploded = true;
      if (rock.isCollabTarget) {
        const result = this.handleAsteroidDamage(rock.id, laser.ownerId, laser.miningDamage);
        if (!result.destroyed) {
          return null;
        }
        return {
          applied: true,
          outcome: 'destroyed',
          asteroidId: rock.id,
          playerId: laser.ownerId,
          points: pointsForRoidSize(rock.size),
          newAsteroids: result.newAsteroids,
          split: false,
          origin: { ...rock.position },
        };
      }
      // Core charges double one physical shot's metal chip; each logical shot
      // is still consumed once and terminal drops/score happen only once.
      let hit = this.applyLaserAsteroidHit(
        rock.id,
        laser.ownerId,
        'laser',
        now,
        laser.miningDamage
      );
      if (laser.energy >= 2 && rock.material === 'metal' && this.getAsteroid(rock.id)) {
        hit = this.applyLaserAsteroidHit(rock.id, laser.ownerId, 'laser', now, laser.miningDamage);
      }
      return hit.applied ? hit : null;
    }
    laser.hasExploded = true;
    return null;
  }

  private emitAsteroidHits(hits: AppliedAsteroidHit[]): void {
    const applied = hits.filter((hit) => hit.applied);
    if (applied.length === 0) {
      return;
    }
    if (this.onAsteroidHits) {
      this.onAsteroidHits(applied);
      return;
    }
    this.pendingAsteroidHits.push(...applied);
  }

  public queueCollabShockwave(origin: Position, now = this.getServerTime()): void {
    const source = { x: origin.x, y: origin.y };
    for (const wave of SHOCKWAVE_WAVES) {
      if (wave.delayFrames <= 0) {
        this.applyShockwaveWave(source, wave);
      } else {
        this.pendingShockwaves.push({
          origin: source,
          radius: wave.radius,
          impulse: wave.impulse,
          fireAt: now + framesToMs(wave.delayFrames),
        });
      }
    }
  }

  public flushDueShockwaves(now = this.getServerTime()): number {
    let applied = 0;
    const remaining: PendingShockwave[] = [];
    for (const pending of this.pendingShockwaves) {
      if (now >= pending.fireAt) {
        this.applyShockwaveWave(pending.origin, pending);
        applied += 1;
      } else {
        remaining.push(pending);
      }
    }
    this.pendingShockwaves = remaining;
    return applied;
  }

  public getPendingShockwaveCount(): number {
    return this.pendingShockwaves.length;
  }

  private applyShockwaveWave(
    origin: Position,
    wave: Pick<ShockwaveWaveSpec, 'radius' | 'impulse'>
  ): void {
    this.asteroidManager.applyRadialImpulse(origin, wave.radius, wave.impulse);
    this.entityManager.applyRadialImpulse(origin, wave.radius, wave.impulse);
  }

  // Game state
  public getGameState() {
    const allEntities = this.entityManager.getAllEntities();
    const exploration = this.exploration.snapshot();
    const loot = this.lootManager.getAll();
    const satellitePickups = this.satellitePickupManager.getAllPickups();
    const gameState = {
      mapAssets: this.mapAssets.snapshot(exploration, loot, satellitePickups),
      exploration: this.exploration.snapshot(),
      completedSectors: [...this.completedSectors].sort(),
      entities: allEntities.map(
        (entity) =>
          ({
            id: entity.id,
            name: entity.name,
            type: entity.type,
            position: entity.position,
            velocity: entity.velocity,
            angle: entity.angle,
            exploding: entity.exploding,
            thrusting: entity.thrusting,
            boost: { ...entity.boost },
            color: entity.color,
            lives: entity.lives,
            score: entity.score,
            silk: entity.silk ?? 0,
            health: entity.health,
            maxHealth: entity.maxHealth,

            mass: entity.mass ?? GROWTH.BASE_MASS,
            ...(entity.respawnTimer !== undefined ? { respawnTimer: entity.respawnTimer } : {}),
            ...(entity.spawnProtectionTimer !== undefined
              ? { spawnProtectionTimer: entity.spawnProtectionTimer }
              : {}),
            kitId: entity.kitId,
            abilityCooldownFrames: entity.abilityCooldownFrames,
            abilityActiveFrames: entity.abilityActiveFrames,

            ...(entity.harpoonTargetId !== undefined
              ? { harpoonTargetId: entity.harpoonTargetId }
              : {}),
            ...(entity.harpoonLatchPos !== undefined
              ? { harpoonLatchPos: entity.harpoonLatchPos }
              : {}),
            ...(entity.kitId === 'hauler' ? { haulerUtility: haulerUtilityOf(entity) } : {}),
            ...(entity.kitId === 'surveyor' ? { surveyorUtility: surveyorUtilityOf(entity) } : {}),
            ...(entity.playerMotion !== undefined ? { playerMotion: entity.playerMotion } : {}),
            ...(entity.laserUpgrade !== undefined ? { laserUpgrade: entity.laserUpgrade } : {}),
            ...(entity.deathCause !== undefined ? { deathCause: entity.deathCause } : {}),
          }) satisfies ServerEntityData
      ),
      asteroids: this.asteroidManager.getAllAsteroids(),
      loot,
      satellitePickups,
      gameTime: this.gameTime,
      isPaused: this.isPaused,
      terrainSeed: getTerrainSeed(),
      spiderField: this.spiderManager.snapshot(),
    } satisfies ServerGameState & Record<keyof ServerGameState, unknown>;

    return gameState;
  }

  public useAbility(entityId: string, requestedKitId?: unknown): boolean {
    const entity = this.entityManager.getEntity(entityId);
    if (!entity) {
      return false;
    }
    // Kit selection is authoritative at join time. Keep accepting the
    // client's matching echo, but reject an alternate or malformed kit so an
    // ability request cannot rewrite health, size, or movement stats.
    if (requestedKitId !== undefined && requestedKitId !== entity.kitId) {
      return false;
    }
    if (entity.kitId === 'surveyor') {
      if (surveyorUtilityOf(entity) === 'survey_probe') {
        return this.launchSurveyProbe(entity);
      }
      const activated = activateAbilityOnHost(entity).activated;
      if (activated) {
        this.surveyNearbyAsteroids(entity);
      }
      return activated;
    }
    const cargo = new Set(
      this.entityManager.getAllEntities().map((actor) => actor.harpoonTargetId)
    );
    const world = {
      asteroids: [
        ...this.getAllAsteroids().filter((asteroid) =>
          this.haulerCanTarget(entity, asteroid, cargo)
        ),
        ...this.spiderManager
          .getBodies()
          .filter((spider) => !cargo.has(spider.id) || spider.id === entity.harpoonTargetId),
      ],
    };
    const priorTargetId = entity.harpoonTargetId;
    const activation = activateAbilityOnHost(entity, world);
    if (activation.activated && entity.harpoonTargetId && isResourceTapUtility(entity)) {
      this.spiderManager.provoke(entity.harpoonTargetId, entity.id);
    }
    if (activation.activated && priorTargetId) {
      const ignited = this.getAsteroid(priorTargetId);
      if (ignited?.boost?.phase === 'burning') {
        for (const ownerId of boostOwnerIds(ignited.boost)) {
          const owner = this.entityManager.getEntity(ownerId);
          if (owner) {
            clearHaulerLatch(owner);
          }
        }
      }
    }
    return activation.activated;
  }

  /** Ordinary cargo is exclusive; a colossal deposit can share tows or armed couplings. */
  private haulerCanTarget(
    entity: GameEntity,
    asteroid: AsteroidData,
    cargo: ReadonlySet<string | null | undefined>
  ): boolean {
    if (asteroid.id === entity.harpoonTargetId || !cargo.has(asteroid.id)) {
      return true;
    }
    if (!isColossalAsteroid(asteroid.size) || asteroid.boost?.phase === 'burning') {
      return false;
    }
    if (asteroid.boost?.phase === 'armed') {
      return (
        haulerUtilityOf(entity) === 'boost_coupling' &&
        boostOwnerIds(asteroid.boost).length < asteroidCrewNeeded(asteroid.size)
      );
    }
    return isTowCableUtility(entity) && !asteroid.boost;
  }

  private surveyNearbyAsteroids(
    surveyor: GameEntity,
    asteroids = this.getAllAsteroids(),
    range: number = SHIP_ABILITY.SCAN_RANGE
  ): void {
    this.surveyFromPosition(surveyor.id, surveyor.position, asteroids, range);
  }

  private surveyFromPosition(
    ownerId: string,
    position: Position,
    asteroids: readonly AsteroidData[],
    range: number
  ): void {
    this.exploration.reveal(position, range);
    for (const rock of asteroids) {
      if (
        rock.health <= 0 ||
        rock.boost?.phase === 'burning' ||
        Math.hypot(rock.position.x - position.x, rock.position.y - position.y) > range
      ) {
        continue;
      }
      rock.surveyedBy ??= [];
      if (!rock.surveyedBy.includes(ownerId)) {
        rock.surveyedBy.push(ownerId);
      }
    }
  }

  private tickSurveyProbes(now: number): void {
    this.surveyProbeManager.tick(
      now,
      () => this.getAllAsteroids(),
      (hostId) => this.getAsteroid(hostId) ?? this.spiderManager.getBody(hostId),
      ({ ownerId, position, asteroids }) =>
        this.surveyFromPosition(ownerId, position, asteroids, SURVEY_PROBE.RANGE)
    );
  }

  private launchSurveyProbe(surveyor: GameEntity): boolean {
    const now = this.getServerTime();
    this.surveyProbeManager.prune(
      now,
      (hostId) => this.getAsteroid(hostId) ?? this.spiderManager.getBody(hostId)
    );
    const asteroids = this.getAllAsteroids();
    const result = this.surveyProbeManager.launch(
      surveyor,
      asteroids,
      this.completedSectors,
      now,
      this.spiderManager.getBodies()
    );
    if (!result) {
      return false;
    }
    surveyor.abilityCooldownFrames = SURVEY_PROBE.COOLDOWN_FRAMES;
    this.surveyProbeManager.pulseNow(
      result.host,
      result.probe,
      asteroids,
      ({ ownerId, position, asteroids: nearby }) =>
        this.surveyFromPosition(ownerId, position, nearby, SURVEY_PROBE.RANGE)
    );
    if ('rotation' in result.host) {
      result.host.surveyedBy ??= [];
      if (!result.host.surveyedBy.includes(result.probe.ownerId)) {
        result.host.surveyedBy.push(result.probe.ownerId);
      }
    }
    return true;
  }

  private damageSurveyProbe(hostId: string, damage: number): boolean {
    return this.surveyProbeManager.damage(hostId, damage);
  }

  public tickAbilities(now = this.getServerTime()): void {
    this.entityManager.tickAbilityState();
    const rocks = this.getAllAsteroids();
    const asteroidIndex = new AsteroidSpatialIndex(rocks);
    const towCrew = new Map<string, number>();
    for (const actor of this.entityManager.getAllEntities()) {
      if (
        isTowCableUtility(actor) &&
        actor.harpoonTargetId &&
        !actor.exploding &&
        actor.health > 0 &&
        actor.respawnTimer === undefined
      ) {
        towCrew.set(actor.harpoonTargetId, (towCrew.get(actor.harpoonTargetId) ?? 0) + 1);
      }
    }
    for (const entity of this.entityManager.getAllEntities()) {
      if (!entity.exploding && entity.health > 0 && entity.respawnTimer === undefined) {
        this.exploration.reveal(
          entity.position,
          entity.kitId === 'surveyor' && entity.abilityActiveFrames > 0
            ? SHIP_ABILITY.SCAN_RANGE
            : EXPLORATION_RANGE[entity.kitId]
        );
      }
      if (entity.laserUpgrade && entity.laserUpgrade.expiresAt <= now) {
        delete entity.laserUpgrade;
      }
      const scanRange =
        entity.kitId === 'surveyor' && entity.abilityActiveFrames > 0
          ? SHIP_ABILITY.SCAN_RANGE
          : this.satellitePickupManager.countOrbitingFor(entity.id) > 0
            ? SATELLITE_PICKUP.SCAN_RANGE
            : 0;
      if (
        scanRange > 0 &&
        !entity.exploding &&
        entity.health > 0 &&
        entity.respawnTimer === undefined
      ) {
        const nearbyAsteroids = asteroidIndex.query({
          minX: entity.position.x - scanRange,
          minY: entity.position.y - scanRange,
          maxX: entity.position.x + scanRange,
          maxY: entity.position.y + scanRange,
        });
        this.surveyNearbyAsteroids(entity, nearbyAsteroids, scanRange);
      }
      const spider = entity.harpoonTargetId
        ? this.spiderManager.getBody(entity.harpoonTargetId)
        : undefined;
      const target = entity.harpoonTargetId
        ? (this.getAsteroid(entity.harpoonTargetId) ?? spider)
        : undefined;
      if (target && 'boost' in target && target.boost?.phase === 'burning') {
        clearHaulerLatch(entity);
        continue;
      }
      pullHarpoonTarget(
        entity,
        target ? [target] : [],
        target !== undefined && (towCrew.get(target.id) ?? 0) >= asteroidCrewNeeded(target.size)
      );
      const extract = tickTapExtract(entity, target);
      if ((extract === 'burst' || extract === 'complete') && target) {
        const burst =
          Math.floor(
            ((entity.tapExtractFrames ?? 0) * SHIP_ABILITY.TAP_EXTRACT_BURSTS) /
              SHIP_ABILITY.TAP_EXTRACT_FRAMES
          ) - 1;
        const ejection = tapLootEjection(entity.position, target, burst);
        const hasSilk = !spider || this.spiderManager.extractSilk(spider.id, entity.id);
        if (!hasSilk) {
          clearHaulerLatch(entity);
          continue;
        }
        const drop = spider
          ? this.lootManager.spawnSilk(ejection.position, this.gameTime, ejection.velocity)
          : this.lootManager.spawnTap(ejection.position, this.gameTime, ejection.velocity);
        if (this.pendingTapEjections.length >= MAX_PENDING_LOOT_COLLECTIONS) {
          this.pendingTapEjections.shift();
        }
        this.pendingTapEjections.push({ lootId: drop.id, position: { ...drop.position } });
        if (extract === 'complete') {
          clearHaulerLatch(entity);
        }
      }
    }
    for (const rock of rocks) {
      if (rock.boost?.phase !== 'armed') {
        continue;
      }
      for (const ownerId of boostOwnerIds(rock.boost)) {
        const owner = this.entityManager.getEntity(ownerId);
        if (
          !owner ||
          owner.exploding ||
          owner.health <= 0 ||
          owner.harpoonTargetId !== rock.id ||
          haulerUtilityOf(owner) !== 'boost_coupling'
        ) {
          rock.boost = removeBoostOwner(rock.boost, ownerId);
          if (!rock.boost) {
            break;
          }
        }
      }
    }
  }

  public setHaulerUtility(entityId: string, utilityId: unknown): boolean {
    const entity = this.entityManager.getEntity(entityId);
    if (!entity) {
      return false;
    }
    const targetId = entity.harpoonTargetId;
    const changed = setHaulerUtilityOnHost(entity, utilityId);
    if (changed && entity.harpoonTargetId !== targetId) {
      this.cancelArmedBoost(entity.id, targetId);
    }
    return changed;
  }

  public setSurveyorUtility(entityId: string, utilityId: unknown): boolean {
    const entity = this.entityManager.getEntity(entityId);
    if (entity?.kitId !== 'surveyor') {
      return false;
    }
    return setSurveyorUtilityOnHost(entity, utilityId);
  }

  private cancelArmedBoost(ownerId: string, targetId: string | null): boolean {
    const target = targetId ? this.getAsteroid(targetId) : undefined;
    if (target?.boost?.phase !== 'armed' || !boostOwnerIds(target.boost).includes(ownerId)) {
      return false;
    }
    target.boost = removeBoostOwner(target.boost, ownerId);
    return true;
  }

  private towCrewOf(asteroidId: string): string[] {
    const ids: string[] = [];
    for (const entity of this.entityManager.getAllEntities()) {
      if (
        isTowCableUtility(entity) &&
        entity.harpoonTargetId === asteroidId &&
        !entity.exploding &&
        entity.health > 0 &&
        entity.respawnTimer === undefined
      ) {
        ids.push(entity.id);
      }
    }
    return ids;
  }

  /** Furnace intake accepts towed or self-guided cargo once; loose rocks remain. */
  public processFurnaceDeliveries(): void {
    const deliveries: FurnaceDelivery[] = [];
    for (const hauler of this.entityManager.getAllEntities()) {
      if (
        hauler.kitId !== 'hauler' ||
        !isTowCableUtility(hauler) ||
        !hauler.harpoonTargetId ||
        hauler.exploding ||
        hauler.health <= 0 ||
        hauler.respawnTimer !== undefined
      ) {
        continue;
      }
      const rock = this.getAsteroid(hauler.harpoonTargetId);
      if (!rock || rock.health <= 0) {
        continue;
      }
      const furnace = FURNACES.find(
        (site) =>
          Math.hypot(rock.position.x - site.position.x, rock.position.y - site.position.y) <=
          site.radius
      );
      if (
        !furnace ||
        Math.hypot(hauler.position.x - furnace.position.x, hauler.position.y - furnace.position.y) >
          furnace.radius + SHIP_ABILITY.HARPOON_RANGE * SHIP_ABILITY.HARPOON_SLACK
      ) {
        continue;
      }
      deliveries.push(this.deliverAsteroid(rock, furnace, this.towCrewOf(rock.id)));
    }
    for (const rock of this.getAllAsteroids()) {
      if (rock.health <= 0 || rock.boost?.phase !== 'burning') {
        continue;
      }
      const furnace = FURNACES.find(
        (site) =>
          Math.hypot(rock.position.x - site.position.x, rock.position.y - site.position.y) <=
          site.radius
      );
      if (furnace) {
        deliveries.push(this.deliverAsteroid(rock, furnace, boostOwnerIds(rock.boost)));
      }
    }
    this.pendingFurnaceDeliveries.push(...deliveries);
  }

  private deliverAsteroid(
    rock: AsteroidData,
    furnace: (typeof FURNACES)[number],
    ownerIds: readonly string[]
  ): FurnaceDelivery {
    this.removeAsteroid(rock.id);
    const launchers = new Set(ownerIds);
    const recipients = new Set([...launchers, ...(rock.surveyedBy ?? [])]);
    const points = furnaceReward(rock);
    const rewards: FurnaceDelivery['rewards'] = [];
    for (const playerId of recipients) {
      const player = this.getPlayer(playerId);
      const score = this.awardPilotPoints(
        playerId,
        points,
        rock.boost?.phase === 'burning' && launchers.has(playerId)
      );
      if (score === undefined) {
        continue;
      }
      const saved = this.pilots.get(playerId);
      rewards.push({ playerId, playerName: player?.name ?? saved?.name ?? '', points, score });
    }
    this.releaseTowsAttachedTo(rock.id);
    return {
      furnaceId: furnace.id,
      asteroidId: rock.id,
      position: { ...furnace.position },
      material: rock.material ?? 'rubble',
      rewards,
    };
  }

  public drainFurnaceDeliveries(): FurnaceDelivery[] {
    return this.pendingFurnaceDeliveries.splice(0);
  }

  public handleAsteroidDamage(
    asteroidId: string,
    playerId: string,
    miningDamage = this.miningDamage(playerId)
  ): { destroyed: boolean; asteroid: AsteroidData | null; newAsteroids: AsteroidData[] } {
    const current = this.asteroidManager.getAsteroid(asteroidId);
    if (!current?.isCollabTarget || current.boost?.phase === 'burning') {
      return { destroyed: false, asteroid: null, newAsteroids: [] };
    }

    // Mining strength comes from the authoritative kit. Client-supplied
    // damage and points are never authoritative.
    this.asteroidManager.recordMiningHit(asteroidId, playerId);
    const asteroid = this.asteroidManager.damageAsteroid(asteroidId, miningDamage);
    if (!asteroid) {
      return { destroyed: false, asteroid: null, newAsteroids: [] };
    }
    if (asteroid.health > 0) {
      return { destroyed: false, asteroid, newAsteroids: [] };
    }
    // Chip-to-zero is kits coop HP, not the 1s split window.
    const result = this.asteroidManager.destroyFromCollision(asteroidId);
    if (result.destroyed) {
      this.releaseTowsAttachedTo(asteroidId);
      const points = pointsForRoidSize(result.destroyed.size);
      this.awardMiningPoints(
        playerId,
        points,
        result.contributors ?? [],
        result.destroyed.surveyedBy ?? []
      );
      this.dropShardAt(result.destroyed.position, asteroidShardMass(result.destroyed.material));
    }
    return {
      destroyed: result.outcome === 'destroyed',
      asteroid,
      newAsteroids: result.newAsteroids,
    };
  }

  public getLoot(): LootData[] {
    return this.lootManager.getAll();
  }

  /** Server-authoritative pickup: first overlapping live ship wins. */
  public collectLoot(
    now = this.getServerTime()
  ): Array<{ collectorId: string; lootId: string; mass: number }> {
    const collected = this.lootManager.collectOverlaps(this.entityManager.getAllEntities());
    const results: Array<{ collectorId: string; lootId: string; mass: number }> = [];
    const events: LootCollected[] = [];
    for (const { collector, loot } of collected) {
      events.push({
        lootId: loot.id,
        collectorId: collector.id,
        kind: loot.kind,
        position: { ...loot.position },
      });
      if (loot.kind === 'silk') {
        collector.silk = (collector.silk ?? 0) + 1;
        collector.lastUpdate = this.getServerTime();
        this.capturePilot(collector.id);
        results.push({ collectorId: collector.id, lootId: loot.id, mass: collector.mass });
        continue;
      }
      if (loot.kind === 'laserCore') {
        collector.laserUpgrade = {
          charges: ASTEROID_INTERACTIONS.coreCharges,
          expiresAt: now + ASTEROID_INTERACTIONS.coreLifetimeMs,
        };
        this.awardPoints(collector.id, ASTEROID_INTERACTIONS.coreScore);
        results.push({ collectorId: collector.id, lootId: loot.id, mass: collector.mass });
        continue;
      }

      applyShipMass(collector, applyLootMass(collector.mass ?? GROWTH.BASE_MASS, loot.mass));
      if (loot.kind === 'shard') {
        this.awardPoints(collector.id, GROWTH.SHARD_SCORE);
      }
      if (loot.kind === 'tap') {
        this.awardPoints(collector.id, GROWTH.TAP_LOOT_SCORE);
      }
      collector.lastUpdate = this.getServerTime();
      results.push({ collectorId: collector.id, lootId: loot.id, mass: collector.mass });
      logger.debug('LOOT', 'Collected loot', {
        collectorId: collector.id,
        lootId: loot.id,
        kind: loot.kind,
        mass: collector.mass,
        maxHealth: collector.maxHealth,
      });
    }
    if (results.length > 0) {
      for (const event of events) {
        if (this.pendingLootCollections.length >= MAX_PENDING_LOOT_COLLECTIONS) {
          this.pendingLootCollections.shift();
        }
        this.pendingLootCollections.push(event);
      }
    }
    return results;
  }

  /**
   * Shooting a drop consumes it and pushes nearby small asteroids. Crew hulls are safe.
   */
  public handleLootExplode(
    playerId: string,
    lootId: string
  ): {
    success: boolean;
    loot?: LootData;
    origin?: Position;
    pushedAsteroidIds: string[];
  } {
    const empty = { success: false, pushedAsteroidIds: [] as string[] };
    const shooter = this.entityManager.getEntity(playerId);
    if (
      !shooter ||
      shooter.exploding ||
      shooter.health <= 0 ||
      shooter.respawnTimer !== undefined
    ) {
      return empty;
    }

    const loot = this.lootManager.get(lootId);
    if (!loot || !inLootArmRange(shooter.position, loot.position)) {
      return empty;
    }

    this.lootManager.remove(lootId);
    const origin = loot.position;
    const pushedAsteroidIds: string[] = [];

    for (const asteroid of this.asteroidManager.getAllAsteroids()) {
      if (
        asteroid.boost?.phase === 'burning' ||
        !isSmallRoid(asteroid.size) ||
        !inBlastRadius(origin, asteroid.position, asteroid.size)
      ) {
        continue;
      }
      const impulse = blastPush(origin, asteroid.position);
      asteroid.velocity.x += impulse.x;
      asteroid.velocity.y += impulse.y;
      pushedAsteroidIds.push(asteroid.id);
    }

    return { success: true, loot, origin, pushedAsteroidIds };
  }

  private dropShardAt(position: Position, mass?: number): LootData {
    return this.lootManager.spawnShard(position, this.gameTime, mass);
  }

  /** Award a score to a live actor or to its saved offline pilot record. */
  private awardPilotPoints(
    entityId: string,
    points: number,
    allowEliminated = false
  ): number | undefined {
    const entity = this.getPlayer(entityId);
    if (entity) {
      if (!allowEliminated && entity.lives <= 0) {
        return entity.score;
      }
      this.awardPoints(entityId, points);
      return entity.score;
    }
    const saved = this.pilots.get(entityId);
    if (saved) {
      if (!allowEliminated && saved.lives !== undefined && saved.lives <= 0) {
        return saved.score;
      }
      const next = this.writePilotScore(saved, saved.score + points);
      this.setPilot(next);
      return next.score;
    }
    return undefined;
  }

  /** Award one full destruction value to each distinct mining contributor. */
  private awardMiningPoints(
    primaryId: string,
    points: number,
    contributors?: readonly string[],
    surveyedBy?: readonly string[]
  ): void {
    const recipients = new Set([primaryId, ...(contributors ?? []), ...(surveyedBy ?? [])]);
    for (const entityId of recipients) {
      this.awardPilotPoints(entityId, points);
    }
  }

  // Award points to a live entity
  private awardPoints(entityId: string, points: number): void {
    const entity = this.entityManager.getEntity(entityId);
    if (entity) {
      entity.score += points;
      entity.lastUpdate = this.getServerTime();
    }
  }

  public getTerrainSeed(): number {
    return getTerrainSeed();
  }

  private validatePosition(position: Position): Position | null {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return null;
    }
    return { x: position.x, y: position.y };
  }
}
