import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import { asteroidShardMass } from '../../shared/asteroidMaterials';
import {
  ASTEROID_INTERACTIONS,
  advanceReflectionEnergy,
  seedAsteroidPhenomena,
  segmentCircleContact,
} from '../../shared/asteroidPhenomena';
import { findNearestAsteroidImpact, reflectVector } from '../../shared/asteroidReflection';
import { asteroidRamDamage, shipShipTickDamage } from '../../shared/combat';
import { calculateHealthRegenDelayFrames } from '../../shared/constants/health';
import { applyFuelPickup, ensureFuelTank, isFuelLoot } from '../../shared/fuel';
import { consumeTickAccumulator, GAME_TICK_MS, MAX_TICK_DEBT_MS } from '../../shared/gameClock';
import {
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
  LOOT_BLAST,
} from '../../shared/lootBlast';
import { findNearestShieldImpact, reflectProjectileVelocity } from '../../shared/shieldReflection';
import { applyLootMass, applyShipMass, GROWTH, radiusFromMass } from '../../shared/shipGrowth';
import { captureDiagnosticActorState } from '../../shared/stateDiagnostics';
import type {
  ActiveCollabTag,
  AsteroidData,
  LootData,
  PlayerProjectileState,
  Position,
  SatelliteData,
  SatellitePickupCollected,
  SatellitePickupData,
  SatelliteProjectileState,
  SatelliteShoot,
  ServerEntityData,
  ServerGameState,
  ShipKitId,
  SoftFactionId,
  Velocity,
} from '../../shared-types';
import {
  CANVAS,
  DAMAGE,
  GAME,
  LASER,
  ROID,
  SATELLITE,
  SATELLITE_PICKUP,
  SHIP,
} from '../../src/constants';
import { canDealCombatDamage } from '../../src/entities/player/softFactions';
import { pointsForRoidSize } from '../../src/entities/roid/roidScore';
import { activateAbilityOnHost, pullHarpoonTarget } from '../../src/entities/ship/shipAbilities';
import { getShipKit, SHIP_ABILITY } from '../../src/entities/ship/shipKits';
import {
  type CombatDamageSource,
  isReadableShieldUp,
  laserCollisionRadius,
  noteReadableShieldLaserHit,
  requestShield,
  resolveCombatDamageSource,
  shieldSnapshot,
} from '../../src/entities/ship/shipShield';
import { getAsteroidFieldRadius } from '../../src/physics/asteroidMotion';
import { framesToMs, SHOCKWAVE_WAVES, type ShockwaveWaveSpec } from '../../src/physics/shockwave';
import { TERRAIN } from '../../src/physics/terrain/terrainConfig';
import { ensureTerrain, getTerrainSeed } from '../../src/physics/terrain/terrainSession';
import { getVelocityMagnitude } from '../../src/utils/mathUtils';
import type { BotShot } from '../ai/botController';
import { serverPerformanceMetrics } from '../performanceMetrics';
import { SERVER_RELEASE_ID } from '../release';
import {
  type AsteroidHitCause,
  type AsteroidHitOutcome,
  AsteroidManager,
  type ExpiredCollabHit,
} from './AsteroidManager.ts';
import { CollisionAuthority } from './CollisionAuthority';
import { killScoreFor, shouldAwardHumanKillPoints } from './combatScoring';
import { EntityManager, type GameEntity } from './EntityManager';
import { LootManager } from './LootManager';
import { PlayerMotionService } from './PlayerMotionService';
import { RNGService } from './RNGService';
import type { SatelliteHit } from './SatelliteManager';
import { SatelliteManager } from './SatelliteManager';
import { SatellitePickupManager } from './SatellitePickupManager';
import { ServerClock } from './ServerClock';

interface ServerLaser {
  id: string;
  ownerId: string;
  /** Firing allegiance survives owner departure; never serialized to clients. */
  readonly ownerFaction?: SoftFactionId;
  position: Position;
  prevPosition: Position;
  velocity: Velocity;
  distTraveled: number;
  hasExploded: boolean;
  energy: number;
  bounces: number;
  age: number;
  lastAsteroidId?: string;
  lastShieldId?: string;
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
  targetType: 'human' | 'bot';
  targetName: string;
  awardedScore?: { playerId: string; score: number };
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
export const HUMAN_SHOOT_POSE_ALLOWANCE_MS = 250;
/** Bounded positional rounding/muzzle disagreement in addition to the movement allowance. */
const HUMAN_SHOOT_MUZZLE_SLOP = 8;
/** Stationary/counter-thrust shots must not remain in the authoritative list forever. */
export const HUMAN_LASER_MAX_LIFETIME_MS = 5000;
const MAX_PENDING_SATELLITE_PICKUP_EVENTS = 32;

type PendingShockwave = {
  origin: Position;
  radius: number;
  impulse: number;
  fireAt: number;
};

export class GameEngine {
  public entityManager: EntityManager;
  private asteroidManager: AsteroidManager;
  private lootManager: LootManager;
  private satelliteManager: SatelliteManager;
  private satellitePickupManager: SatellitePickupManager;
  private rngService: RNGService;
  private collisionAuthority = new CollisionAuthority();
  private combatSink: CombatSink | null = null;
  private gameTime = 0;
  private gameLoopInterval: NodeJS.Timeout | null = null;
  private isPaused = false; // Track if game is paused due to no players
  private lastTickAtMs = 0;
  private nextTickDueAtMs = 0;
  private tickAccumulatorMs = 0;
  private clockPrimed = false;
  private lastSimulationAtMs: number | undefined;
  private resolvedCollabHits: ExpiredCollabHit[] = [];
  private lasers: ServerLaser[] = [];
  private laserSeq = 0;
  private readonly laserNonce = randomUUID();
  public readonly playerMotion = new PlayerMotionService();
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
  private pendingShockwaves: PendingShockwave[] = [];
  private pendingSatelliteShots: SatelliteShoot[] = [];
  private pendingSatellitePickupCollections: SatellitePickupCollected[] = [];
  private readonly humanShootBudgets = new WeakMap<GameEntity, { tokens: number; at: number }>();
  private readonly humanLaserExpiry = new WeakMap<ServerLaser, number>();
  private readonly damageStateLogs = new WeakMap<GameEntity, number>();

  constructor(
    rngSeed?: number,
    private readonly serverClock = new ServerClock()
  ) {
    this.rngService = new RNGService(rngSeed);
    this.entityManager = new EntityManager(this.rngService, () => this.getServerTime());
    this.asteroidManager = new AsteroidManager(this.rngService);
    this.lootManager = new LootManager(this.rngService);
    this.satelliteManager = new SatelliteManager(this.rngService);
    this.satellitePickupManager = new SatellitePickupManager(this.rngService);
    ensureTerrain(TERRAIN.DEFAULT_SEED);

    // Don't initialize pause state yet - will be called after initialization
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
      this.nextTickDueAtMs = serverNow + GAME_TICK_MS;
      this.clockPrimed = true;
      return 0;
    }
    const elapsed = serverNow - this.lastTickAtMs;
    this.lastTickAtMs = serverNow;
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
    return frames;
  }

  /** One 60 Hz frame: clock always ticks; combat/field only while a human is in. */
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
    this.gameTime++;
    if (this.isPaused) {
      return;
    }
    this.entityManager.cleanupStaleEntities();
    this.entityManager.updateExplosions();
    this.logRespawns(this.entityManager.updateRespawns());
    for (const id of this.playerMotion.step(serverNow)) {
      this.removePlayer(id);
      this.departedPlayers.push(id);
    }
    this.tickAbilities(serverNow);
    this.entityManager.updateShields();
    this.entityManager.updateHealthRegeneration();
    this.lootManager.expire(this.gameTime);
    this.collectLoot(serverNow);
    this.tickSatellitePickups();
    this.asteroidManager.updateMotion();
    if (this.gameTime % 60 === 0) {
      this.seedAsteroidInteractions();
    }
    this.emitAsteroidHits(this.advanceLasersAndResolveHits(serverNow));
    this.flushDueShockwaves(serverNow);
    this.flushExpiredCollabHits(serverNow);
    if (this.gameTime % 2 === 0) {
      this.queueBotShots(this.entityManager.updateBotMovement());
    }
    this.resolveAuthoritativeCombat(serverNow);
    // Destruction can remove the last row during this frame. Refill before
    // the next snapshot so active players never wait for a reconnect.
    this.ensureAsteroidField();
    const shots = this.satelliteManager.update(this.satelliteHuntTargets());
    if (shots.length > 0) {
      this.pendingSatelliteShots.push(...shots);
    }
    this.applySatelliteHits(this.satelliteManager.drainHits());
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
    this.entityManager.updateShields();
    this.entityManager.updateHealthRegeneration();
  }

  public stopGameLoop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    this.lastTickAtMs = 0;
    this.nextTickDueAtMs = 0;
    this.tickAccumulatorMs = 0;
    this.clockPrimed = false;
    this.lastSimulationAtMs = undefined;
  }

  // Pause/resume functionality
  public updatePauseState(): void {
    const humanPlayerCount = this.entityManager.getHumanPlayerCount();

    if (humanPlayerCount === 0 && !this.isPaused) {
      this.isPaused = true;
      logger.info('🔄 Game paused - no human players online');
      // Reset game state when last player disconnects to ensure clean state for next player
      this.resetGameState();
      logger.debug('🧹 Reset game state due to no players');
    } else if (humanPlayerCount > 0 && this.isPaused) {
      this.isPaused = false;
      logger.info('▶️ Game resumed - human players are back online');
      // Bots were cleared by resetGameState() while paused. Recreate them so
      // there are always opponents whenever a human is actively playing.
      if (this.entityManager.getBotCount() === 0) {
        const bots = this.createBots(3);
        if (bots) {
          logger.info(`🤖 Recreated ${bots.length} bots on resume`);
        }
      }
      this.ensureAmbientSatellites();
    } else if (humanPlayerCount > 0) {
      this.ensureAmbientSatellites();
    }
  }

  private ensureAmbientSatellites(): void {
    if (this.satelliteManager.getCount() === 0) {
      const satellites = this.createSatellites(SATELLITE.AMBIENT_COUNT);
      if (satellites) {
        logger.info(`🛰️ Ambient hostile NPCs in arena: ${satellites.length}`);
      }
    }

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
    humanPlayers: number;
    bots: number;
    asteroids: number;
    loot: number;
    satellites: number;
    satellitePickups: number;
  } {
    return {
      isPaused: this.isPaused,
      gameTime: this.gameTime,
      humanPlayers: this.entityManager.getHumanPlayerCount(),
      bots: this.entityManager.getBotCount(),
      asteroids: this.asteroidManager.getAsteroidCount(),
      loot: this.lootManager.getCount(),
      satellites: this.satelliteManager.getCount(),
      satellitePickups: this.satellitePickupManager.getCount(),
    };
  }

  /**
   * Force the world back to the empty paused state used after the last human
   * disconnects. Intended for integration/E2E test harnesses only.
   */
  public resetForTesting(): void {
    const closeErrors: Error[] = [];
    for (const entity of this.entityManager.getAllEntities()) {
      if (entity.type === 'human' && entity.ws) {
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
      throw new AggregateError(closeErrors, 'Test world reset could not close every human socket');
    }
    this.resetGameState();
    this.isPaused = true;
    this.rngService.reset();
  }

  // Clear ambient entities and pending combat without replacing human sessions.
  private clearWorldObjects(): void {
    // Clear all asteroids and pending collab resolutions
    this.asteroidManager.clearAsteroids();
    this.resolvedCollabHits = [];
    this.pendingShockwaves = [];
    this.lootManager.clear();
    this.lasers = [];
    this.departedPlayers = [];
    this.decoratedFieldId = undefined;
    this.pendingLootBlasts = [];
    this.pendingAsteroidHits = [];
    this.satelliteManager.clearSatellites();
    this.pendingSatelliteShots = [];
    this.pendingSatellitePickupCollections = [];
    this.satellitePickupManager.clear();

    this.collisionAuthority.reset();
  }

  /** Atomic between-tick arrangement for the benchmark process's private control socket. */
  public prepareDiagnosticWorld(scenario: 'traversal' | 'combat'): void {
    this.clearWorldObjects();
    for (const bot of this.getAllBots()) {
      this.removeBot(bot.id);
    }
    this.rngService.reset();
    this.createAsteroids(scenario === 'combat' ? 80 : ROID.INITIAL_ROID_COUNT);
    this.seedAsteroidInteractions();
    this.createBots(scenario === 'combat' ? 2 : 3);
    this.createSatellites(SATELLITE.AMBIENT_COUNT);
    this.ensureSatellitePickups();
  }

  private resetGameState(): void {
    this.clearWorldObjects();
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
    color?: string,
    kitId?: ShipKitId,
    factionId?: SoftFactionId
  ): GameEntity {
    const entity = this.entityManager.addHumanPlayer(
      id,
      name,
      ws,
      position,
      color,
      kitId,
      factionId
    );
    this.updatePauseState();
    return entity;
  }

  /** Old human id remapped by same-name takeover. */
  public consumeReplacedHumanId(): string | undefined {
    return this.entityManager.consumeReplacedHumanId();
  }

  public removePlayer(id: string): GameEntity | undefined {
    this.playerMotion.forgetActor(id);
    this.satellitePickupManager.releaseOwner(id);
    const entity = this.entityManager.removeEntity(id);
    this.updatePauseState();
    return entity;
  }

  public transportClosed(ws: WebSocket): boolean {
    return this.playerMotion.transportClosed(ws, this.getServerTime());
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
    return this.entityManager.getHumanPlayers();
  }

  public getPlayerCount(): number {
    return this.entityManager.getHumanPlayerCount();
  }

  // Asteroid operations
  public addAsteroid(asteroid: AsteroidData): void {
    this.asteroidManager.addAsteroid(asteroid);
  }

  public removeAsteroid(asteroidId: string): AsteroidData | undefined {
    return this.asteroidManager.removeAsteroid(asteroidId);
  }

  public updateAsteroid(
    asteroidId: string,
    updates: Partial<AsteroidData>
  ): AsteroidData | undefined {
    return this.asteroidManager.updateAsteroid(asteroidId, updates);
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

  public drainLootBlasts() {
    return this.pendingLootBlasts.splice(0);
  }

  public getAsteroidCount(): number {
    return this.asteroidManager.getAsteroidCount();
  }

  /**
   * Ensure an active arena has a canonical server-owned asteroid field.
   *
   * Returns the rows created in this call so a transport can broadcast the
   * replenishment immediately. An existing field, a paused world, and a world
   * with no human players are all no-ops.
   */
  public ensureAsteroidField(): AsteroidData[] {
    if (this.isPaused || this.entityManager.getHumanPlayerCount() === 0) {
      return [];
    }
    if (this.asteroidManager.getAsteroidCount() > 0) {
      return [];
    }
    this.decoratedFieldId = undefined;

    const entities = this.entityManager.getAllEntities();
    const playerPositions = entities
      .filter((entity) => entity.type === 'human')
      .map((entity) => entity.position);
    const botPositions = entities
      .filter((entity) => entity.type === 'bot')
      .map((entity) => entity.position);
    const asteroids = this.createAsteroids(
      ROID.INITIAL_ROID_COUNT,
      { radius: getAsteroidFieldRadius() },
      botPositions,
      playerPositions
    );
    this.seedAsteroidInteractions();
    logger.info('ASTEROID', 'Seeded active asteroid field', {
      asteroidCount: asteroids.length,
      humanPlayers: playerPositions.length,
      bots: botPositions.length,
    });
    return asteroids;
  }

  public createAsteroids(
    count: number,
    bounds = { radius: getAsteroidFieldRadius() },
    botPositions: Array<{ x: number; y: number }> = [],
    playerPositions: Array<{ x: number; y: number }> = []
  ): AsteroidData[] {
    return this.asteroidManager.createAsteroids(count, bounds, botPositions, playerPositions);
  }

  // Bot operations
  public createBots(count: number): GameEntity[] | null {
    return this.entityManager.createBotsSafely(count);
  }

  public getBot(botId: string): GameEntity | undefined {
    const entity = this.entityManager.getEntity(botId);
    return entity?.type === 'bot' ? entity : undefined;
  }

  public getAllBots(): GameEntity[] {
    return this.entityManager.getBots();
  }

  public createSatellites(count: number): SatelliteData[] | null {
    return this.satelliteManager.createSatellitesSafely(count);
  }

  public getSatellite(satelliteId: string) {
    return this.satelliteManager.getSatellite(satelliteId);
  }

  public getAllSatellites(): SatelliteData[] {
    return this.satelliteManager.getAllSatellites();
  }

  public getSatelliteCount(): number {
    return this.satelliteManager.getCount();
  }

  /** Snapshot source for active EO projectiles; transport owns serialization. */
  public getActiveSatelliteProjectiles(): SatelliteProjectileState[] {
    return this.satelliteManager.getActiveProjectiles();
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

  /** Keep the pickup field alive for every active arena. */
  public ensureSatellitePickups(): SatellitePickupData[] {
    if (this.isPaused || this.entityManager.getHumanPlayerCount() === 0) {
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
      radius: radiusFromMass(entity.mass ?? GROWTH.BASE_MASS),
      health: entity.health,
      exploding: entity.exploding,
    }));
    this.satellitePickupManager.update(owners);
    this.collectNearbySatellitePickups();
    return this.getAllSatellitePickups();
  }

  private collectNearbySatellitePickups(): void {
    const humans = this.entityManager
      .getHumanPlayers()
      .filter(
        (entity) => entity.health > 0 && !entity.exploding && entity.respawnTimer === undefined
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    const loosePickups = this.satellitePickupManager
      .getAllPickups()
      .filter((pickup) => pickup.state === 'loose' && pickup.health > 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const pickup of loosePickups) {
      const collector = humans
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

      const collected = this.satellitePickupManager.collect(
        pickup.id,
        {
          id: collector.id,
          position: collector.position,
          radius: radiusFromMass(collector.mass ?? GROWTH.BASE_MASS),
          health: collector.health,
          exploding: collector.exploding,
        },
        this.satellitePickupManager.nextOrbitPhaseFor(collector.id)
      );
      if (!collected) {
        continue;
      }

      collector.score += SATELLITE_PICKUP.SCORE_BONUS;
      collector.lastUpdate = this.getServerTime();
      this.queueSatellitePickupCollected({
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

  public drainSatelliteShots(): SatelliteShoot[] {
    const shots = this.pendingSatelliteShots;
    this.pendingSatelliteShots = [];
    return shots;
  }

  /** Apply one authoritative physical hit to a live satellite pickup. */
  public handleSatellitePickupDamage(pickupId: string, damage: number): SatellitePickupData | null {
    return this.satellitePickupManager.damage(pickupId, damage);
  }

  public handleSatelliteDamage(satelliteId: string, attackerId: string, damage: number): boolean {
    const damaged = this.satelliteManager.damageSatellite(satelliteId, damage);
    if (!damaged) {
      return false;
    }
    if (damaged.health <= 0 && damaged.exploding) {
      this.lootManager.spawnFromPosition(damaged.position, SATELLITE.MASS, this.gameTime);
      this.awardPoints(attackerId, SATELLITE.POINTS);
      return true;
    }
    return false;
  }

  public tickSatellites(): SatelliteShoot[] {
    const shots = this.satelliteManager.update(this.satelliteHuntTargets());
    if (shots.length > 0) {
      this.pendingSatelliteShots.push(...shots);
    }
    this.applySatelliteHits(this.satelliteManager.drainHits());
    return shots;
  }

  private satelliteHuntTargets(): Array<{
    id: string;
    position: Position;
    radius: number;
    health: number;
    exploding: boolean;
    respawnTimer?: number;
    aimable?: boolean;
    kind?: 'ship' | 'pickup' | 'satellite';
    shieldActive?: boolean;
    shieldTime?: number;
    shieldTimer?: number;
    onShieldHit?: () => void;
  }> {
    return [
      ...this.entityManager.getAllEntities().map((entity) => ({
        id: entity.id,
        position: entity.position,
        radius: radiusFromMass(entity.mass ?? GROWTH.BASE_MASS),
        health: entity.health,
        exploding: entity.exploding,
        ...(entity.respawnTimer !== undefined ? { respawnTimer: entity.respawnTimer } : {}),
        shieldActive: entity.shieldActive,
        shieldTime: entity.shieldTime,
        shieldTimer: entity.shieldTimer,
        onShieldHit: () => noteReadableShieldLaserHit(entity),
        kind: 'ship' as const,
      })),
      ...this.satellitePickupManager
        .getAllPickups()
        .filter((pickup) => pickup.state !== 'broken' && pickup.health > 0)
        .map((pickup) => ({
          id: pickup.id,
          position: pickup.position,
          radius: pickup.radius,
          health: pickup.health,
          exploding: false,
          aimable: false,
          kind: 'pickup' as const,
        })),
      ...this.satelliteManager
        .getAllSatellites()
        .filter((satellite) => !satellite.exploding && satellite.health > 0)
        .map((satellite) => ({
          id: satellite.id,
          position: satellite.position,
          radius: satellite.radius,
          health: satellite.health,
          exploding: satellite.exploding,
          aimable: false,
          kind: 'satellite' as const,
        })),
    ];
  }

  private applySatelliteHits(hits: SatelliteHit[]): void {
    for (const hit of hits) {
      if (hit.targetKind === 'pickup') {
        this.handleSatellitePickupDamage(hit.targetId, hit.damage);
        continue;
      }
      if (hit.targetKind === 'satellite') {
        this.satelliteManager.damageSatellite(hit.targetId, hit.damage);
        continue;
      }
      const result = this.applyDirectedHit(hit.targetId, hit.satelliteId, hit.damage, 'laser');
      if (result) {
        this.combatSink?.(result);
      }
    }
  }

  public updateBot(botId: string, updates: Partial<GameEntity>): GameEntity | undefined {
    return this.entityManager.updateEntity(botId, updates);
  }

  public removeBot(botId: string): GameEntity | undefined {
    return this.entityManager.removeEntity(botId);
  }

  // Game logic operations — humans and bots share the same friendly-fire gate.
  public requestShield(entityId: string, active: boolean): boolean {
    const entity = this.entityManager.getEntity(entityId);
    if (!entity || entity.exploding || entity.health <= 0 || entity.respawnTimer !== undefined) {
      return false;
    }
    const changed = requestShield(entity, active, entity.exploding, entity.kitId);
    if (changed) {
      entity.lastUpdate = this.getServerTime();
    }
    return changed;
  }

  /**
   * Apply damage to a human or bot through one path. Shield, faction, loot,
   * and deathCause stay on the tip helpers; health/lives stay server-owned.
   */
  public handleShipDamage(
    targetId: string,
    attackerId: string,
    damage: number,
    source?: CombatDamageSource
  ): { applied: boolean; isDestroyed: boolean; entity?: GameEntity } {
    logger.debug('handleShipDamage called', { targetId, attackerId, damage, source });
    if (!this.combatSidesAllowDamage(attackerId, targetId)) {
      logger.debug('friendly fire ignored', { attackerId, targetId });
      return { applied: false, isDestroyed: false };
    }

    const existing = this.entityManager.getEntity(targetId);
    if (!existing) {
      return { applied: false, isDestroyed: false };
    }
    if (existing.respawnTimer !== undefined || existing.health <= 0 || existing.exploding) {
      return { applied: false, isDestroyed: false };
    }

    const healthBefore = existing.health;
    const livesBefore = existing.lives;
    const resolvedSource = resolveCombatDamageSource(attackerId, source);
    const damaged = this.entityManager.damageEntity(targetId, damage, resolvedSource);
    if (!damaged) {
      return { applied: false, isDestroyed: false };
    }

    if (damaged.health > 0) {
      if (damaged.health < healthBefore) {
        this.logDamageState(
          damaged,
          attackerId,
          resolvedSource,
          damage,
          healthBefore,
          livesBefore,
          false
        );
      }
      return { applied: true, isDestroyed: false, entity: damaged };
    }

    this.applyShipDeath(damaged, attackerId, killScoreFor(damaged.type));
    this.logDamageState(
      damaged,
      attackerId,
      resolvedSource,
      damage,
      healthBefore,
      livesBefore,
      true
    );
    return { applied: true, isDestroyed: true, entity: damaged };
  }

  private logDamageState(
    entity: GameEntity,
    attackerId: string,
    source: CombatDamageSource,
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
      source,
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
      logger.info('STATE', 'player_respawned', {
        releaseId: SERVER_RELEASE_ID,
        playerId,
        observedAt: Date.now(),
        gameTime: this.gameTime,
        state: captureDiagnosticActorState(entity),
      });
    }
  }

  public handlePlayerDamage(
    targetPlayerId: string,
    attackerId: string,
    damage: number,
    source?: CombatDamageSource
  ): boolean {
    const existing = this.getPlayer(targetPlayerId);
    if (existing?.type !== 'human') {
      return false;
    }
    return this.handleShipDamage(targetPlayerId, attackerId, damage, source).isDestroyed;
  }

  public handleBotDamage(
    botId: string,
    attackerId: string,
    damage: number,
    source?: CombatDamageSource
  ): boolean {
    const existing = this.getBot(botId);
    if (existing?.type !== 'bot') {
      return false;
    }
    return this.handleShipDamage(botId, attackerId, damage, source).isDestroyed;
  }

  /**
   * Server-owned ship↔asteroid, ship↔satellite, and ship↔ship resolution.
   * Humans and bots share the same overlap + handleShipDamage path. Asteroid
   * motion already ran in the game loop (`updateMotion`); this only applies
   * health. Ram uses the tip collision destroy path so laser collab stays intact.
   */
  public resolveAuthoritativeCombat(now: number = this.getServerTime()): CombatBroadcast[] {
    if (this.isPaused) {
      return [];
    }

    const results: CombatBroadcast[] = [];
    const entities = this.entityManager.getAllEntities();

    const pickupBodyHits = this.collisionAuthority.collectAsteroidPickupHits(
      this.asteroidManager.getAllAsteroids(),
      this.satellitePickupManager.getAllPickups()
    );
    for (const hit of pickupBodyHits) {
      this.handleSatellitePickupDamage(hit.pickupId, DAMAGE.LASER_HIT);
    }

    const ramHits = this.collisionAuthority.collectShipAsteroidHits(
      entities,
      this.asteroidManager.getAllAsteroids(),
      (shipId, asteroidId) => this.isActiveHarpoonTarget(shipId, asteroidId)
    );
    const destroyedAsteroids = new Set<string>();
    const ramDamage = asteroidRamDamage();
    for (const hit of ramHits) {
      const result = this.applyDirectedHit(hit.shipId, 'asteroid', ramDamage, 'collision');
      if (!result) {
        continue;
      }
      if (!destroyedAsteroids.has(hit.asteroidId)) {
        destroyedAsteroids.add(hit.asteroidId);
        const destruction = this.handleAsteroidHit(hit.asteroidId, hit.shipId, 'collision');
        if (destruction.outcome === 'destroyed') {
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
      results.push(result);
    }

    const satHits = this.collisionAuthority.collectShipSatelliteHits(
      entities,
      this.satelliteManager.getAllSatellites()
    );
    for (const hit of satHits) {
      const result = this.applyDirectedHit(
        hit.shipId,
        hit.satelliteId,
        SATELLITE.COLLISION_DAMAGE,
        'collision'
      );
      if (result) {
        results.push(result);
      }
      this.handleSatelliteDamage(hit.satelliteId, hit.shipId, SATELLITE.COLLISION_DAMAGE);
    }

    const pairTicks = this.collisionAuthority.collectShipShipTicks(entities, now);
    const tickDamage = shipShipTickDamage();
    for (const pair of pairTicks) {
      const first = this.applyDirectedHit(pair.a, pair.b, tickDamage, 'collision');
      if (first) {
        results.push(first);
      }
      const second = this.applyDirectedHit(pair.b, pair.a, tickDamage, 'collision');
      if (second) {
        results.push(second);
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
    return ship?.kitId === 'hauler' && ship.harpoonTimer > 0 && ship.harpoonTargetId === asteroidId;
  }

  private applyDirectedHit(
    targetId: string,
    attackerId: string,
    damage: number,
    source?: CombatDamageSource
  ): CombatBroadcast | null {
    const outcome = this.handleShipDamage(targetId, attackerId, damage, source);
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
      targetName: outcome.entity.name,
    };
    if (outcome.isDestroyed) {
      const attacker = this.entityManager.getEntity(attackerId);
      if (attacker) {
        broadcast.awardedScore = { playerId: attackerId, score: attacker.score };
      }
    }
    return broadcast;
  }

  /** One death path for humans and bots: loot, lives (humans), points, shared respawn. */
  private applyShipDeath(entity: GameEntity, attackerId: string, killPoints: number): void {
    if (attackerId) {
      entity.deathCause = attackerId;
    }
    this.playerMotion.invalidateLife(entity.id, this.getServerTime());
    delete entity.laserUpgrade;
    this.satellitePickupManager.releaseOwner(entity.id);
    this.lootManager.spawnFromKill(entity, this.gameTime);
    if (entity.type === 'human') {
      entity.lives = Math.max(0, entity.lives - 1);
      if (
        shouldAwardHumanKillPoints(
          attackerId,
          entity.id,
          !!this.entityManager.getEntity(attackerId)
        )
      ) {
        this.awardPoints(attackerId, killPoints);
      }
    } else if (attackerId) {
      this.awardPoints(attackerId, killPoints);
    }
    this.entityManager.scheduleShipRespawn(entity);
  }

  public handleAsteroidHit(
    asteroidId: string,
    playerId: string,
    cause: AsteroidHitCause = 'laser',
    now = this.getServerTime()
  ): AsteroidHitOutcome {
    const target = this.getAsteroid(asteroidId);
    const coreSource = target?.phenomenon?.kind === 'reflective';
    const result =
      cause === 'collision'
        ? this.asteroidManager.destroyFromCollision(asteroidId)
        : this.asteroidManager.registerLaserHit(asteroidId, playerId, now);

    if (result.outcome === 'destroyed' && result.destroyed) {
      this.awardPoints(playerId, pointsForRoidSize(result.destroyed.size));
      this.dropShardAt(result.destroyed.position, asteroidShardMass(result.destroyed.material));
      this.maybeDropFuel(result.destroyed);
      if (coreSource) {
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
    now = this.getServerTime()
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

    const result = this.handleAsteroidHit(asteroidId, playerId, cause, now);
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
      split: result.split && asteroid.material !== 'rubble',
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      origin,
    };
  }

  public flushExpiredCollabHits(now = this.getServerTime()): ExpiredCollabHit[] {
    const expired = this.asteroidManager.expireStaleHits(now);
    for (const item of expired) {
      this.awardPoints(item.playerId, item.points);
      this.dropShardAt(item.destroyed.position, asteroidShardMass(item.destroyed.material));
      this.maybeDropFuel(item.destroyed);
      this.resolvedCollabHits.push(item);
    }
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
   * Untrusted human wire entry point. Bots/tests use spawnLaser for server-authored shots.
   * Aim remains client-predicted, but ownership alone is not proof of a valid muzzle.
   */
  public spawnHumanLaser(
    ownerId: string,
    start: Position,
    velocity: Velocity,
    now = this.getServerTime()
  ): ServerLaser | null {
    const shooter = this.entityManager.getEntity(ownerId);
    if (
      shooter?.type !== 'human' ||
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
    // Account for legitimate dash and radial impulse before the next movement clamp.
    const maxShipSpeed = kit.maxVelocity + SHIP_ABILITY.DASH_BOOST + SHIP_ABILITY.SHOCK_FORCE;
    const maxLaserSpeed = maxShipSpeed + LASER.SPEED / GAME.FPS;
    const muzzleRadius = (4 / 3) * Math.max(kit.size / 2, radiusFromMass(shooter.mass));
    const maxOriginDistance =
      muzzleRadius +
      HUMAN_SHOOT_MUZZLE_SLOP +
      maxShipSpeed * GAME.FPS * (HUMAN_SHOOT_POSE_ALLOWANCE_MS / 1000);
    if (
      Math.hypot(start.x - shooter.position.x, start.y - shooter.position.y) > maxOriginDistance ||
      Math.hypot(velocity.x, velocity.y) > maxLaserSpeed ||
      Math.hypot(shooter.velocity.x, shooter.velocity.y) > maxShipSpeed
    ) {
      return null;
    }
    // A bounded burst bucket tolerates packet bunching and the three-shot E volley
    // (whose shoot packets precede useAbility). Sustained rate follows kit cooldown;
    // Skirmisher also earns its two additional volley rounds per ability cooldown.
    const previous = this.humanShootBudgets.get(shooter);
    const bonusRate =
      (kit.burstCount - 1) / (SHIP_ABILITY.COOLDOWN_FRAMES[kit.id] * (1000 / GAME.FPS));
    const rate = 1 / kit.shotCooldown + bonusRate;
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
    this.humanShootBudgets.set(shooter, { tokens: available - 1, at: now });
    this.humanLaserExpiry.set(laser, now + HUMAN_LASER_MAX_LIFETIME_MS);
    return laser;
  }

  /** Spawn a simulated shot. Used for human `shoot` and the same helper can take a bot id. */
  public spawnLaser(
    ownerId: string,
    start: Position,
    velocity: Velocity,
    now = this.getServerTime()
  ): ServerLaser | null {
    const position = this.validatePosition(start);
    const vx = typeof velocity?.x === 'number' && Number.isFinite(velocity.x) ? velocity.x : NaN;
    const vy = typeof velocity?.y === 'number' && Number.isFinite(velocity.y) ? velocity.y : NaN;
    if (!position || !Number.isFinite(vx) || !Number.isFinite(vy)) {
      return null;
    }

    this.laserSeq += 1;
    const owner = this.getPlayer(ownerId);
    const laser: ServerLaser = {
      id: `server-laser-${this.laserNonce}-${ownerId}-${this.laserSeq}`,
      ownerId,
      ...(owner?.factionId !== undefined ? { ownerFaction: owner.factionId } : {}),
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
    return laser;
  }

  public getServerLasers(): readonly ServerLaser[] {
    return this.lasers;
  }

  /** Move live lasers and apply at most one break per asteroid / laser. */
  public advanceLasersAndResolveHits(now = this.getServerTime()): AppliedAsteroidHit[] {
    const hits: AppliedAsteroidHit[] = [];

    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined) {
        continue;
      }
      if (laser.hasExploded || now >= (this.humanLaserExpiry.get(laser) ?? Infinity)) {
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

      const hit = this.resolveLaserAgainstAsteroids(laser, now);
      if (hit) {
        hits.push(hit);
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
    const index = this.lasers.findIndex((laser) => laser.id === laserId);
    const laser = this.lasers[index];
    if (!laser || laser.hasExploded || laser.age !== 0) {
      return [];
    }
    const hit = this.resolveLaserAgainstAsteroids(laser, now);
    if (laser.hasExploded) {
      this.lasers.splice(index, 1);
    }
    return hit ? [hit] : [];
  }

  private resolveLaserAgainstAsteroids(laser: ServerLaser, now: number): AppliedAsteroidHit | null {
    return this.resolveEnhancedLaser(laser, now);
  }

  /** Live laser-reflecting surfaces; spawn protection never becomes a shield. */
  private getLaserShieldSurfaces(laser: ServerLaser): Array<{
    id: string;
    position: Position;
    radius: number;
  }> {
    return this.entityManager
      .getAllEntities()
      .filter((entity) => {
        if (
          entity.id === laser.ownerId ||
          entity.health <= 0 ||
          entity.exploding ||
          entity.respawnTimer !== undefined ||
          !isReadableShieldUp(entity)
        ) {
          return false;
        }
        // A direct shot obeys the existing friendly-fire filter. Once it has
        // bounced, the reflected shot may reach a same-faction shield too.
        return laser.bounces > 0 || canDealCombatDamage(laser.ownerFaction, entity.factionId);
      })
      .map((entity) => ({
        id: entity.id,
        position: entity.position,
        radius: laserCollisionRadius(radiusFromMass(entity.mass), entity),
      }));
  }

  /** Full swept path for the enhanced world. Every bounce consumes distance and
   * shares the preview's nearest polygon geometry; ship contact can occur first. */
  private resolveEnhancedLaser(laser: ServerLaser, now: number): AppliedAsteroidHit | null {
    let start = { ...laser.prevPosition };
    let end = { ...laser.position };
    for (let work = 0; work <= ASTEROID_INTERACTIONS.maxBounces; work++) {
      const rocks = this.getAllAsteroids();
      const impact = findNearestAsteroidImpact(start, end, rocks, laser.lastAsteroidId);
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const shieldSurfaces = this.getLaserShieldSurfaces(laser);
      const shieldImpact = findNearestShieldImpact(start, end, shieldSurfaces, laser.lastShieldId);
      const originShield = shieldSurfaces.find((shield) => {
        const dx = start.x - shield.position.x;
        const dy = start.y - shield.position.y;
        return dx * dx + dy * dy < shield.radius * shield.radius;
      });
      const originRadial = originShield
        ? {
            x: start.x - originShield.position.x,
            y: start.y - originShield.position.y,
          }
        : undefined;
      const originMovingOutward =
        originShield &&
        originRadial &&
        originRadial.x * (end.x - start.x) + originRadial.y * (end.y - start.y) >= 0;
      const owner = this.getPlayer(laser.ownerId);
      const contacts = this.entityManager
        .getAllEntities()
        .flatMap((entity) => {
          if (entity.health <= 0 || entity.exploding || entity.respawnTimer !== undefined) {
            return [];
          }
          if (
            laser.bounces === 0 &&
            (entity.id === laser.ownerId ||
              !canDealCombatDamage(laser.ownerFaction, entity.factionId))
          ) {
            return [];
          }
          const fraction = segmentCircleContact(
            start,
            end,
            entity.position,
            radiusFromMass(entity.mass)
          );
          return fraction === undefined ? [] : [{ entity, distance: fraction * distance }];
        })
        .sort((a, b) => a.distance - b.distance || a.entity.id.localeCompare(b.entity.id));
      const contact = contacts[0];
      const auxiliary = [
        ...this.satelliteManager
          .getAllSatellites()
          .filter((satellite) => !satellite.exploding && satellite.health > 0)
          .map((satellite) => ({
            id: satellite.id,
            position: satellite.position,
            radius: satellite.radius,
            ownerId: undefined,
            kind: 'satellite' as const,
          })),
        ...this.satellitePickupManager
          .getAllPickups()
          .filter((pickup) => pickup.state !== 'broken' && pickup.health > 0)
          .map((pickup) => ({
            id: pickup.id,
            position: pickup.position,
            radius: pickup.radius,
            ownerId: pickup.ownerId,
            kind: 'satellitePickup' as const,
          })),
        ...this.getLoot()
          .filter((loot) => owner && inLootArmRange(owner.position, loot.position))
          .map((loot) => ({
            id: loot.id,
            position: loot.position,
            radius: loot.radius,
            ownerId: undefined,
            kind: 'loot' as const,
          })),
      ]
        .filter((target) => {
          if (target.kind !== 'satellitePickup' || laser.bounces > 0 || !target.ownerId) {
            return true;
          }
          const pickupOwner = this.entityManager.getEntity(target.ownerId);
          return (
            pickupOwner === undefined ||
            (pickupOwner.id !== laser.ownerId &&
              canDealCombatDamage(laser.ownerFaction, pickupOwner.factionId))
          );
        })
        .flatMap((target) => {
          const fraction = segmentCircleContact(start, end, target.position, target.radius);
          return fraction === undefined ? [] : [{ ...target, distance: fraction * distance }];
        })
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0];
      // A muzzle can begin inside a larger shield while remaining outside the
      // hull. If it is already moving out, carry it to the exit before
      // considering hull/auxiliary contacts; the shield must not become a
      // damageable gap just because the first authoritative segment started
      // inside its bubble. An inward origin is handled below as an immediate
      // radial reflection by the shared swept helper.
      if (originMovingOutward && originShield && distance > 1e-7) {
        if (!shieldImpact || shieldImpact.shieldId !== originShield.id) {
          laser.position = end;
          return null;
        }
        const remaining = Math.max(0, distance - shieldImpact.distance);
        const speed = Math.hypot(laser.velocity.x, laser.velocity.y);
        if (speed <= 1e-9) {
          laser.position = end;
          return null;
        }
        const direction = { x: laser.velocity.x / speed, y: laser.velocity.y / speed };
        laser.position = { ...shieldImpact.point };
        laser.lastShieldId = originShield.id;
        start = {
          x: shieldImpact.point.x + direction.x * 1e-5,
          y: shieldImpact.point.y + direction.y * 1e-5,
        };
        end = { x: start.x + direction.x * remaining, y: start.y + direction.y * remaining };
        continue;
      }
      if (
        auxiliary &&
        (!impact || auxiliary.distance < impact.distance) &&
        (!contact || auxiliary.distance < contact.distance) &&
        (!shieldImpact || auxiliary.distance < shieldImpact.distance)
      ) {
        laser.hasExploded = true;
        if (auxiliary.kind === 'satellite') {
          this.handleSatelliteDamage(auxiliary.id, laser.ownerId, DAMAGE.LASER_HIT * laser.energy);
        } else if (auxiliary.kind === 'satellitePickup') {
          this.handleSatellitePickupDamage(auxiliary.id, DAMAGE.LASER_HIT * laser.energy);
        } else {
          const blast = this.handleLootExplode(laser.ownerId, auxiliary.id);
          if (blast.success && blast.origin) {
            this.pendingLootBlasts.push({
              lootId: auxiliary.id,
              position: { ...blast.origin },
              radius: LOOT_BLAST.RADIUS,
              shooterId: laser.ownerId,
            });
          }
        }
        return null;
      }
      if (
        shieldImpact &&
        (!impact || shieldImpact.distance < impact.distance) &&
        (!contact || shieldImpact.distance <= contact.distance) &&
        (!auxiliary || shieldImpact.distance <= auxiliary.distance)
      ) {
        if (laser.bounces >= ASTEROID_INTERACTIONS.maxBounces) {
          laser.position = { ...shieldImpact.point };
          laser.hasExploded = true;
          return null;
        }
        const shieldedEntity = this.entityManager.getEntity(shieldImpact.shieldId);
        if (shieldedEntity) {
          noteReadableShieldLaserHit(shieldedEntity);
        }
        laser.position = { ...shieldImpact.point };
        laser.velocity = reflectProjectileVelocity(laser.velocity, shieldImpact.normal);
        laser.bounces += 1;
        laser.lastShieldId = shieldImpact.shieldId;
        const speed = Math.hypot(laser.velocity.x, laser.velocity.y);
        if (speed <= 1e-9) {
          laser.hasExploded = true;
          return null;
        }
        const remaining = Math.max(0, distance - shieldImpact.distance);
        const direction = { x: laser.velocity.x / speed, y: laser.velocity.y / speed };
        start = {
          x: shieldImpact.point.x + direction.x * 1e-5,
          y: shieldImpact.point.y + direction.y * 1e-5,
        };
        end = { x: start.x + direction.x * remaining, y: start.y + direction.y * remaining };
        continue;
      }
      if (
        contact &&
        (!impact || contact.distance < impact.distance) &&
        (!shieldImpact || contact.distance < shieldImpact.distance)
      ) {
        const friendly =
          contact.entity.id === laser.ownerId ||
          !canDealCombatDamage(laser.ownerFaction, contact.entity.factionId);
        const attacker = friendly ? `ricochet:${laser.ownerId}` : laser.ownerId;
        const result = this.applyDirectedHit(
          contact.entity.id,
          attacker,
          DAMAGE.LASER_HIT * laser.energy,
          'laser'
        );
        if (result) {
          this.combatSink?.(result);
        }
        laser.hasExploded = true;
        return null;
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
        const result = this.handleAsteroidDamage(rock.id, laser.ownerId);
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
      let hit = this.applyLaserAsteroidHit(rock.id, laser.ownerId, 'laser', now);
      if (laser.energy >= 2 && rock.material === 'metal' && this.getAsteroid(rock.id)) {
        hit = this.applyLaserAsteroidHit(rock.id, laser.ownerId, 'laser', now);
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
    const gameState = {
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
            color: entity.color,
            lives: entity.lives,
            score: entity.score,
            health: entity.health,
            maxHealth: entity.maxHealth,
            fuel: ensureFuelTank(entity).fuel,
            maxFuel: entity.maxFuel,
            mass: entity.mass ?? GROWTH.BASE_MASS,
            ...(entity.respawnTimer !== undefined ? { respawnTimer: entity.respawnTimer } : {}),
            ...(entity.spawnProtectionTimer !== undefined
              ? { spawnProtectionTimer: entity.spawnProtectionTimer }
              : {}),
            kitId: entity.kitId,
            ...(entity.factionId !== undefined ? { factionId: entity.factionId } : {}),
            abilityCooldownFrames: entity.abilityCooldownFrames,
            abilityActiveFrames: entity.abilityActiveFrames,
            shieldTimer: entity.shieldTimer,
            ...(entity.shieldTargetId !== undefined
              ? { shieldTargetId: entity.shieldTargetId }
              : {}),
            ...(entity.shieldSourceId !== undefined
              ? { shieldSourceId: entity.shieldSourceId }
              : {}),
            harpoonTimer: entity.harpoonTimer,
            ...(entity.harpoonTargetId !== undefined
              ? { harpoonTargetId: entity.harpoonTargetId }
              : {}),
            ...(entity.harpoonLatchPos !== undefined
              ? { harpoonLatchPos: entity.harpoonLatchPos }
              : {}),
            ...(entity.playerMotion !== undefined ? { playerMotion: entity.playerMotion } : {}),
            ...(entity.laserUpgrade !== undefined ? { laserUpgrade: entity.laserUpgrade } : {}),
            ...(entity.deathCause !== undefined ? { deathCause: entity.deathCause } : {}),
            ...shieldSnapshot(entity),
          }) satisfies ServerEntityData
      ),
      asteroids: this.asteroidManager.getAllAsteroids(),
      loot: this.lootManager.getAll(),
      satellites: this.satelliteManager.getAllSatellites(),
      satellitePickups: this.satellitePickupManager.getAllPickups(),
      gameTime: this.gameTime,
      isPaused: this.isPaused,
      terrainSeed: getTerrainSeed(),
    } satisfies ServerGameState & Record<keyof ServerGameState, unknown>;

    return gameState;
  }

  private combatSidesAllowDamage(attackerId: string, targetId: string): boolean {
    if (
      !attackerId ||
      attackerId === 'asteroid' ||
      attackerId === 'boundary' ||
      attackerId === 'loot' ||
      attackerId.startsWith('ricochet:') ||
      attackerId.startsWith('server-sat-') ||
      targetId.startsWith('server-sat-')
    ) {
      return true;
    }
    const attacker = this.entityManager.getEntity(attackerId);
    const target = this.entityManager.getEntity(targetId);
    return canDealCombatDamage(attacker?.factionId, target?.factionId);
  }

  public useAbility(
    entityId: string,
    requestedKitId?: unknown,
    latchView?: { playfieldScale?: number; canvas?: { width: number; height: number } }
  ): boolean {
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
    const world = {
      asteroids: this.asteroidManager.getAllAsteroids().map((asteroid) => ({
        ...asteroid,
        r: asteroid.size,
        kind: 'asteroid' as const,
      })),
      entities: this.entityManager.getAllEntities().filter((other) => other.id !== entityId),
      ...(latchView?.playfieldScale !== undefined
        ? { playfieldScale: latchView.playfieldScale }
        : {}),
      ...(latchView?.canvas !== undefined ? { canvas: latchView.canvas } : {}),
    };
    return activateAbilityOnHost(entity, world).activated;
  }

  public tickAbilities(now = this.getServerTime()): void {
    this.entityManager.tickAbilityState();
    const asteroids = this.asteroidManager.getAllAsteroids();
    const entities = this.entityManager.getAllEntities();
    const emptyCandidates: Array<AsteroidData | GameEntity> = [];
    let sharedCandidates: Array<AsteroidData | GameEntity> | undefined;
    for (const entity of entities) {
      if (entity.laserUpgrade && entity.laserUpgrade.expiresAt <= now) {
        delete entity.laserUpgrade;
      }
      if (this.playerMotion.ownsActorMotion(entity.id)) {
        continue;
      }
      const targetId = entity.harpoonTargetId;
      // Non-Haulers and inactive latches return before reading candidates, but
      // still need the helper to clear stale state.
      if (entity.kitId !== 'hauler' || entity.harpoonTimer <= 0 || !targetId) {
        pullHarpoonTarget(entity, emptyCandidates);
        continue;
      }
      sharedCandidates ??= [...asteroids, ...entities];
      pullHarpoonTarget(entity, sharedCandidates);
    }
  }

  public handleAsteroidDamage(
    asteroidId: string,
    playerId: string
  ): { destroyed: boolean; asteroid: AsteroidData | null; newAsteroids: AsteroidData[] } {
    const current = this.asteroidManager.getAsteroid(asteroidId);
    if (!current?.isCollabTarget) {
      return { destroyed: false, asteroid: null, newAsteroids: [] };
    }

    // Collaborative chip damage is deliberately fixed to one canonical
    // laser hit. Client-supplied damage and points are never authoritative.
    const asteroid = this.asteroidManager.damageAsteroid(asteroidId, DAMAGE.LASER_HIT);
    if (!asteroid) {
      return { destroyed: false, asteroid: null, newAsteroids: [] };
    }
    if (asteroid.health > 0) {
      return { destroyed: false, asteroid, newAsteroids: [] };
    }
    // Chip-to-zero is kits coop HP, not the 1s split window.
    const result = this.asteroidManager.destroyFromCollision(asteroidId);
    if (result.destroyed) {
      this.awardPoints(playerId, pointsForRoidSize(result.destroyed.size));
      this.dropShardAt(result.destroyed.position, asteroidShardMass(result.destroyed.material));
      this.maybeDropFuel(result.destroyed);
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
    for (const { collector, loot } of collected) {
      if (loot.kind === 'laserCore') {
        collector.laserUpgrade = {
          charges: ASTEROID_INTERACTIONS.coreCharges,
          expiresAt: now + ASTEROID_INTERACTIONS.coreLifetimeMs,
        };
        this.awardPoints(collector.id, ASTEROID_INTERACTIONS.coreScore);
        results.push({ collectorId: collector.id, lootId: loot.id, mass: collector.mass });
        continue;
      }
      if (isFuelLoot(loot)) {
        applyFuelPickup(ensureFuelTank(collector), loot.fuel ?? 0);
        collector.lastUpdate = this.getServerTime();
        results.push({ collectorId: collector.id, lootId: loot.id, mass: collector.mass });
        logger.debug('LOOT', 'Collected fuel drop', {
          collectorId: collector.id,
          lootId: loot.id,
          fuel: collector.fuel,
        });
        continue;
      }
      applyShipMass(collector, applyLootMass(collector.mass ?? GROWTH.BASE_MASS, loot.mass));
      if (loot.kind === 'shard') {
        this.awardPoints(collector.id, GROWTH.SHARD_SCORE);
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
    return results;
  }

  /**
   * Shooting a drop detonates it (GH #313). Environmental blast: hits every
   * nearby live hull, including the shooter. Shields do not absorb it.
   */
  public handleLootExplode(
    playerId: string,
    lootId: string
  ): {
    success: boolean;
    loot?: LootData;
    origin?: Position;
    damagedIds: string[];
    pushedAsteroidIds: string[];
  } {
    const empty = { success: false, damagedIds: [] as string[], pushedAsteroidIds: [] as string[] };
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
    const damagedIds: string[] = [];
    const pushedAsteroidIds: string[] = [];

    for (const entity of this.entityManager.getAllEntities()) {
      const shipR = radiusFromMass(entity.mass ?? GROWTH.BASE_MASS);
      if (!inBlastRadius(origin, entity.position, shipR)) {
        continue;
      }
      if (this.harmFromLootBlast(entity) !== 'ignored') {
        damagedIds.push(entity.id);
      }
    }

    for (const asteroid of this.asteroidManager.getAllAsteroids()) {
      if (!isSmallRoid(asteroid.size) || !inBlastRadius(origin, asteroid.position, asteroid.size)) {
        continue;
      }
      const impulse = blastPush(origin, asteroid.position);
      asteroid.velocity.x += impulse.x;
      asteroid.velocity.y += impulse.y;
      pushedAsteroidIds.push(asteroid.id);
    }

    return { success: true, loot, origin, damagedIds, pushedAsteroidIds };
  }

  private dropShardAt(position: Position, mass?: number): LootData {
    return this.lootManager.spawnShard(position, this.gameTime, mass);
  }

  private harmFromLootBlast(entity: GameEntity): 'hit' | 'killed' | 'ignored' {
    if (entity.exploding || entity.health <= 0 || entity.respawnTimer !== undefined) {
      return 'ignored';
    }
    if (entity.spawnProtectionTimer !== undefined && entity.spawnProtectionTimer > 0) {
      return 'ignored';
    }

    const previousHealth = entity.health;
    entity.health = Math.max(0, entity.health - LOOT_BLAST.DAMAGE);
    if (entity.health < previousHealth) {
      entity.healthRegenTimer = calculateHealthRegenDelayFrames();
    }
    entity.lastUpdate = this.getServerTime();
    if (entity.health <= 0) {
      this.applyShipDeath(entity, 'loot', 0);
      return 'killed';
    }
    return 'hit';
  }

  private maybeDropFuel(asteroid?: AsteroidData): void {
    if (!asteroid) {
      return;
    }
    this.lootManager.spawnFuelFromAsteroid(asteroid, this.gameTime);
  }

  // Award points to an entity
  private awardPoints(entityId: string, points: number): void {
    const entity = this.entityManager.getEntity(entityId);
    if (entity) {
      entity.score += points;
      entity.lastUpdate = this.getServerTime();
    }
  }

  // Bot-specific update methods for testing

  public updateBotMovement(): BotShot[] {
    const shots = this.entityManager.updateBotMovement();
    this.queueBotShots(shots);
    return shots;
  }

  private queueBotShots(shots: BotShot[]): void {
    for (const shot of shots) {
      const bot = this.entityManager.getEntity(shot.botId);
      if (bot?.type !== 'bot') {
        continue;
      }
      this.spawnLaser(shot.botId, shot.laserStart, shot.laserDirection);
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
