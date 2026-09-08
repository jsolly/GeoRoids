import { WebSocket } from 'ws';
import type {
  AsteroidData,
  ActiveCollabTag,
  SatelliteProjectileState,
  ServerGameState,
  ServerEntityData,
  LootData,
  Position,
  SatellitePickupData,
  SatelliteData,
  SatelliteShoot,
  ShipKitId,
  SoftFactionId,
  Velocity,
} from '../../shared-types';
import { asteroidRamDamage, shipShipTickDamage } from '../../shared/combat';
import { applyFuelPickup, ensureFuelTank, isFuelLoot } from '../../shared/fuel';
import { calculateHealthRegenDelayFrames } from '../../shared/constants/health';
import { consumeTickAccumulator, GAME_TICK_MS } from '../../shared/gameClock';
import {
  LOOT_BLAST,
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
} from '../../shared/lootBlast';
import { GROWTH, applyLootMass, applyShipMass, radiusFromMass } from '../../shared/shipGrowth';
import { CANVAS, DAMAGE, GAME, LASER, ROID, SATELLITE, SATELLITE_PICKUP, SHIP } from '../../src/constants';
import { canDealCombatDamage } from '../../src/entities/player/softFactions';
import { pointsForRoidSize } from '../../src/entities/roid/roidScore';
import { activateAbilityOnHost, pullHarpoonTarget } from '../../src/entities/ship/shipAbilities';
import { getShipKit, SHIP_ABILITY } from '../../src/entities/ship/shipKits';
import {
  requestShield,
  resolveCombatDamageSource,
  shieldSnapshot,
  type CombatDamageSource,
} from '../../src/entities/ship/shipShield';
import type { BotShot } from '../ai/botController';
import { getAsteroidFieldRadius } from '../../src/physics/asteroidMotion';
import {
  checkLaserAsteroidCollisionSwept,
  isLaserNearAsteroid,
} from '../../src/physics/collision/collisionDetection';
import { framesToMs, SHOCKWAVE_WAVES, type ShockwaveWaveSpec } from '../../src/physics/shockwave';
import { TERRAIN } from '../../src/physics/terrain/terrainConfig';
import { ensureTerrain, getTerrainSeed } from '../../src/physics/terrain/terrainSession';
import { getVelocityMagnitude } from '../../src/utils/mathUtils';
import { isWithinCollectRange } from '../../src/entities/satellitePickup/satellitePickupMath';
import { logger } from '../../setup/serverLogger';
import {
  AsteroidManager,
  type AsteroidHitCause,
  type AsteroidHitOutcome,
  type ExpiredCollabHit,
} from './AsteroidManager.ts';
import { CollisionAuthority } from './CollisionAuthority';
import { killScoreFor, shouldAwardHumanKillPoints } from './combatScoring';
import { EntityManager, GameEntity } from './EntityManager';
import { LootManager } from './LootManager';
import { asteroidShardMass } from '../../shared/asteroidMaterials';
import { RNGService } from './RNGService';
import { SatelliteManager } from './SatelliteManager';
import { SatellitePickupManager } from './SatellitePickupManager';
import type { SatelliteHit } from './SatelliteManager';

export interface ServerLaser {
  id: string;
  ownerId: string;
  position: Position;
  prevPosition: Position;
  velocity: Velocity;
  distTraveled: number;
  hasExploded: boolean;
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

export type CombatSink = (result: CombatBroadcast) => void;

/** Matches client Laser.isExpired when the canvas is the internal playfield. */
const SERVER_LASER_MAX_DISTANCE = LASER.TRAVEL_DISTANCE_RATIO + CANVAS.INTERNAL_WIDTH;
/** 250 ms covers a delayed position packet at 30 Hz plus a brief browser/network hitch. */
export const HUMAN_SHOOT_POSE_ALLOWANCE_MS = 250;
/** Bounded positional rounding/muzzle disagreement in addition to the movement allowance. */
const HUMAN_SHOOT_MUZZLE_SLOP = 8;
/** Stationary/counter-thrust shots must not remain in the authoritative list forever. */
export const HUMAN_LASER_MAX_LIFETIME_MS = 5000;


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
  private tickAccumulatorMs = 0;
  private clockPrimed = false;
  private resolvedCollabHits: ExpiredCollabHit[] = [];
  private lasers: ServerLaser[] = [];
  private laserSeq = 0;
  private onAsteroidHits?: (hits: AppliedAsteroidHit[]) => void;
  private pendingAsteroidHits: AppliedAsteroidHit[] = [];
  private pendingShockwaves: PendingShockwave[] = [];
  private pendingBotShots: BotShot[] = [];
  private pendingSatelliteShots: SatelliteShoot[] = [];
  private readonly humanShootBudgets = new WeakMap<GameEntity, { tokens: number; at: number }>();
  private readonly humanLaserExpiry = new WeakMap<ServerLaser, number>();

  constructor(rngSeed?: number) {
    this.rngService = new RNGService(rngSeed);
    this.entityManager = new EntityManager(this.rngService);
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

  // Game loop management
  public startGameLoop(): void {
    if (this.gameLoopInterval) {
      return; // Already running
    }

    this.lastTickAtMs = Date.now();
    this.tickAccumulatorMs = 0;
    this.clockPrimed = true;
    this.gameLoopInterval = setInterval(() => {
      this.stepClock(Date.now());
    }, GAME_TICK_MS);
  }

  /**
   * Advance the monotonic clock and catch up missed simulation frames.
   * A blocked event loop used to increment gameTime once per late interval
   * fire, which froze explode/respawn and made /health.world.gameTime look stuck.
   */
  public stepClock(nowMs: number): number {
    if (!this.clockPrimed) {
      this.lastTickAtMs = nowMs;
      this.clockPrimed = true;
      return 0;
    }
    const elapsed = nowMs - this.lastTickAtMs;
    this.lastTickAtMs = nowMs;
    if (!Number.isFinite(elapsed) || elapsed <= 0) {
      return 0;
    }
    this.tickAccumulatorMs += elapsed;
    const { frames, remainingMs } = consumeTickAccumulator(this.tickAccumulatorMs);
    this.tickAccumulatorMs = remainingMs;
    for (let i = 0; i < frames; i++) {
      this.advanceOneFrame();
    }
    return frames;
  }

  /** One 60 Hz frame: clock always ticks; combat/field only while a human is in. */
  public advanceOneFrame(): void {
    this.gameTime++;
    if (this.isPaused) {
      return;
    }
    this.entityManager.cleanupStaleEntities();
    this.entityManager.updateExplosions();
    this.entityManager.updateRespawns();
    this.tickAbilities();
    this.entityManager.updateShields();
    this.entityManager.updateHealthRegeneration();
    this.lootManager.expire(this.gameTime);
    this.collectLoot();
    this.tickSatellitePickups();
    this.asteroidManager.updateMotion();
    this.emitAsteroidHits(this.advanceLasersAndResolveHits());
    this.flushDueShockwaves();
    this.flushExpiredCollabHits();
    if (this.gameTime % 2 === 0) {
      this.queueBotShots(this.entityManager.updateBotMovement());
    }
    this.resolveAuthoritativeCombat();
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
    this.entityManager.updateRespawns();
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
    this.tickAccumulatorMs = 0;
    this.clockPrimed = false;
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
    for (const entity of this.entityManager.getAllEntities()) {
      if (entity.type === 'human' && entity.ws) {
        try {
          entity.ws.close(1000, 'Test world reset');
        } catch {
          // Socket may already be closed.
        }
      }
    }
    this.resetGameState();
    this.isPaused = true;
    this.rngService.reset();
  }

  // Reset game state when no players are online
  private resetGameState(): void {
    // Clear all asteroids and pending collab resolutions
    this.asteroidManager.clearAsteroids();
    this.resolvedCollabHits = [];
    this.pendingShockwaves = [];
    this.lootManager.clear();
    this.lasers = [];
    this.laserSeq = 0;
    this.pendingAsteroidHits = [];
    this.satelliteManager.clearSatellites();
    this.pendingSatelliteShots = [];
    this.satellitePickupManager.clear();
    
    // Clear all entities (bots, players, etc.)
    this.entityManager.clearAll();
    this.collisionAuthority.reset();
    this.pendingBotShots = [];

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
    const entity = this.entityManager.addHumanPlayer(id, name, ws, position, color, kitId, factionId);
    this.updatePauseState();
    return entity;
  }

  /** Old human id remapped by same-name takeover. */
  public consumeReplacedHumanId(): string | undefined {
    return this.entityManager.consumeReplacedHumanId();
  }

  public removePlayer(id: string): GameEntity | undefined {
    this.satellitePickupManager.releaseOwner(id);
    const entity = this.entityManager.removeEntity(id);
    this.updatePauseState();
    return entity;
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

  public updateAsteroid(asteroidId: string, updates: Partial<AsteroidData>): AsteroidData | undefined {
    return this.asteroidManager.updateAsteroid(asteroidId, updates);
  }

  public getAsteroid(asteroidId: string): AsteroidData | undefined {
    return this.asteroidManager.getAsteroid(asteroidId);
  }

  public getAllAsteroids(): AsteroidData[] {
    return this.asteroidManager.getAllAsteroids();
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

  public getBotCount(): number {
    return this.entityManager.getBotCount();
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
  public getActiveCollabTags(now = Date.now()): ActiveCollabTag[] {
    return this.asteroidManager.getActiveCollabTags(now);
  }

  public createSatellitePickups(count: number = SATELLITE_PICKUP.MAX_COUNT): SatellitePickupData[] {
    return this.satellitePickupManager.createPickups(count);
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
    this.satellitePickupManager.update(
      this.entityManager.getAllEntities().map((entity) => ({
        id: entity.id,
        position: entity.position,
        health: entity.health,
        exploding: entity.exploding,
      }))
    );
    return this.getAllSatellitePickups();
  }

  /** First living server-positioned human overlapping a pickup wins. */
  public handleSatellitePickupCollected(
    pickupId: string,
    playerId: string
  ): { success: boolean; pickup?: SatellitePickupData } {
    const pickup = this.satellitePickupManager.getPickup(pickupId);
    const collector = this.entityManager.getEntity(playerId);
    if (
      !pickup ||
      pickup.state !== 'loose' ||
      !collector ||
      collector.type !== 'human' ||
      collector.health <= 0 ||
      collector.exploding ||
      collector.respawnTimer !== undefined
    ) {
      return { success: false };
    }

    if (
      !isWithinCollectRange(
        collector.position,
        pickup.position,
        radiusFromMass(collector.mass ?? GROWTH.BASE_MASS),
        pickup.radius,
        SATELLITE_PICKUP.COLLECT_SLACK
      )
    ) {
      return { success: false };
    }

    const collected = this.satellitePickupManager.collect(
      pickupId,
      playerId,
      this.satellitePickupManager.countOrbitingFor(playerId)
    );
    if (!collected) {
      return { success: false };
    }

    collector.score += SATELLITE_PICKUP.SCORE_BONUS;
    collector.spawnProtectionTimer = Math.max(
      collector.spawnProtectionTimer ?? 0,
      SATELLITE_PICKUP.SHIELD_FRAMES
    );
    collector.lastUpdate = Date.now();
    return { success: true, pickup: collected };
  }

  public drainSatelliteShots(): SatelliteShoot[] {
    const shots = this.pendingSatelliteShots;
    this.pendingSatelliteShots = [];
    return shots;
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
  }> {
    return this.entityManager.getAllEntities().map((entity) => ({
      id: entity.id,
      position: entity.position,
      radius: radiusFromMass(entity.mass ?? GROWTH.BASE_MASS),
      health: entity.health,
      exploding: entity.exploding,
      respawnTimer: entity.respawnTimer,
    }));
  }

  private applySatelliteHits(hits: SatelliteHit[]): void {
    for (const hit of hits) {
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
    const changed = requestShield(entity, active, entity.exploding);
    if (changed) {
      entity.lastUpdate = Date.now();
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

    const damaged = this.entityManager.damageEntity(
      targetId,
      damage,
      resolveCombatDamageSource(attackerId, source)
    );
    if (!damaged) {
      return { applied: false, isDestroyed: false };
    }

    if (damaged.health > 0) {
      return { applied: true, isDestroyed: false, entity: damaged };
    }

    this.applyShipDeath(damaged, attackerId, killScoreFor(damaged.type));
    return { applied: true, isDestroyed: true, entity: damaged };
  }

  public handlePlayerDamage(
    targetPlayerId: string,
    attackerId: string,
    damage: number,
    source?: CombatDamageSource
  ): boolean {
    const existing = this.getPlayer(targetPlayerId);
    if (!existing || existing.type !== 'human') {
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
    if (!existing || existing.type !== 'bot') {
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
  public resolveAuthoritativeCombat(now: number = Date.now()): CombatBroadcast[] {
    if (this.isPaused) {
      return [];
    }

    const results: CombatBroadcast[] = [];
    const entities = this.entityManager.getAllEntities();

    const ramHits = this.collisionAuthority.collectShipAsteroidHits(
      entities,
      this.asteroidManager.getAllAsteroids()
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
          result.origin = destruction.destroyed?.position;
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
    this.satellitePickupManager.releaseOwner(entity.id);
    this.lootManager.spawnFromKill(entity, this.gameTime);
    if (entity.type === 'human') {
      const prevLives = entity.lives;
      entity.lives = Math.max(0, entity.lives - 1);
      logger.info('PLAYER', `Life lost`, {
        playerId: entity.id,
        name: entity.name,
        livesBefore: prevLives,
        livesAfter: entity.lives,
      });
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
    now = Date.now()
  ): AsteroidHitOutcome {
    const result =
      cause === 'collision'
        ? this.asteroidManager.destroyFromCollision(asteroidId)
        : this.asteroidManager.registerLaserHit(asteroidId, playerId, now);

    if (result.outcome === 'destroyed' && result.destroyed) {
      this.awardPoints(playerId, pointsForRoidSize(result.destroyed.size));
      this.dropShardAt(result.destroyed.position, asteroidShardMass(result.destroyed.material));
      this.maybeDropFuel(result.destroyed);
    }

    return result;
  }

  /**
   * Sole apply path for laser/ram reports and the server laser tick.
   * Collab tag/split stays in handleAsteroidHit; callers that accept a client
   * report consume its tracked projectile before entering this method. The
   * authoritative laser tick marks its own exact laser after this apply path,
   * so applying a client hint cannot consume a second coincident shot.
   */
  public applyLaserAsteroidHit(
    asteroidId: string,
    playerId: string,
    laserPosition?: Position,
    cause: AsteroidHitCause = 'laser',
    now = Date.now()
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

    if (
      cause === 'laser' &&
      laserPosition &&
      !isLaserNearAsteroid(laserPosition, asteroid.position, asteroid.size)
    ) {
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
      expiresAt: result.expiresAt,
      origin,
    };
  }

  public flushExpiredCollabHits(now = Date.now()): ExpiredCollabHit[] {
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

  public handleAsteroidDestruction(
    asteroidId: string,
    playerId: string,
    _points?: number
  ): { success: boolean; newAsteroids: AsteroidData[] } {
    const result = this.applyLaserAsteroidHit(asteroidId, playerId);
    return {
      success: result.outcome === 'destroyed',
      newAsteroids: result.newAsteroids,
    };
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
    now = Date.now()
  ): ServerLaser | null {
    const shooter = this.entityManager.getEntity(ownerId);
    if (
      !shooter || shooter.type !== 'human' || shooter.health <= 0 || shooter.exploding ||
      shooter.respawnTimer !== undefined || !Number.isFinite(now) ||
      !Number.isFinite(start?.x) || !Number.isFinite(start?.y) ||
      !Number.isFinite(velocity?.x) || !Number.isFinite(velocity?.y) ||
      !Number.isFinite(shooter.position.x) || !Number.isFinite(shooter.position.y) ||
      !Number.isFinite(shooter.velocity.x) || !Number.isFinite(shooter.velocity.y)
    ) {
      return null;
    }
    const kit = getShipKit(shooter.kitId);
    // Account for legitimate dash and radial impulse before the next movement clamp.
    const maxShipSpeed = kit.maxVelocity + SHIP_ABILITY.DASH_BOOST + SHIP_ABILITY.SHOCK_FORCE;
    const maxLaserSpeed = maxShipSpeed + LASER.SPEED / GAME.FPS;
    const muzzleRadius = (4 / 3) * Math.max(kit.size / 2, radiusFromMass(shooter.mass));
    const maxOriginDistance = muzzleRadius + HUMAN_SHOOT_MUZZLE_SLOP +
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
    const bonusRate = (kit.burstCount - 1) /
      (SHIP_ABILITY.COOLDOWN_FRAMES[kit.id] * (1000 / GAME.FPS));
    const rate = 1 / kit.shotCooldown + bonusRate;
    const available = previous
      ? Math.min(SHIP.MAX_LASERS, previous.tokens + Math.max(0, now - previous.at) * rate)
      : SHIP.MAX_LASERS;
    if (available < 1) {
      return null;
    }
    const laser = this.spawnLaser(ownerId, start, velocity);
    if (!laser) {
      return null;
    }
    this.humanShootBudgets.set(shooter, { tokens: available - 1, at: now });
    this.humanLaserExpiry.set(laser, now + HUMAN_LASER_MAX_LIFETIME_MS);
    return laser;
  }

  /** Spawn a simulated shot. Used for human `shoot` and the same helper can take a bot id. */
  public spawnLaser(ownerId: string, start: Position, velocity: Velocity): ServerLaser | null {
    const position = this.validatePosition(start);
    const vx = typeof velocity?.x === 'number' && Number.isFinite(velocity.x) ? velocity.x : NaN;
    const vy = typeof velocity?.y === 'number' && Number.isFinite(velocity.y) ? velocity.y : NaN;
    if (!position || !Number.isFinite(vx) || !Number.isFinite(vy)) {
      return null;
    }

    this.laserSeq += 1;
    const laser: ServerLaser = {
      id: `server-laser-${ownerId}-${this.laserSeq}`,
      ownerId,
      position: { x: position.x, y: position.y },
      prevPosition: { x: position.x, y: position.y },
      velocity: { x: vx, y: vy },
      distTraveled: 0,
      hasExploded: false,
    };
    this.lasers.push(laser);
    return laser;
  }

  public getServerLasers(): readonly ServerLaser[] {
    return this.lasers;
  }

  /**
   * Bot asteroid reports are only accepted while the server still has the
   * corresponding bot projectile in flight near that same server asteroid.
   * This keeps the existing bot-shot wire shape while rejecting forged bot
   * identities and reports after a shot has already been consumed.
   */
  public hasActiveBotLaserNearAsteroid(botId: string, asteroidId: string): boolean {
    const bot = this.entityManager.getEntity(botId);
    const asteroid = this.asteroidManager.getAsteroid(asteroidId);
    if (bot?.type !== 'bot' || !asteroid) {
      return false;
    }

    return this.lasers.some(
      (laser) =>
        !laser.hasExploded &&
        laser.ownerId === botId &&
        isLaserNearAsteroid(laser.position, asteroid.position, asteroid.size)
    );
  }

  /** Consume one validated bot projectile so duplicate client reports cannot replay it. */
  public consumeActiveBotLaserNearAsteroid(
    botId: string,
    asteroidId: string,
    reportedPosition?: Position
  ): boolean {
    const bot = this.entityManager.getEntity(botId);
    const asteroid = this.asteroidManager.getAsteroid(asteroidId);
    if (
      bot?.type !== 'bot' ||
      !asteroid ||
      (reportedPosition !== undefined &&
        (!this.validatePosition(reportedPosition) ||
          !isLaserNearAsteroid(reportedPosition, asteroid.position, asteroid.size)))
    ) {
      return false;
    }

    const laser = this.lasers.find(
      (candidate) =>
        !candidate.hasExploded &&
        candidate.ownerId === botId &&
        isLaserNearAsteroid(candidate.position, asteroid.position, asteroid.size)
    );
    if (!laser) {
      return false;
    }

    laser.hasExploded = true;
    return true;
  }

  /**
   * Bot loot reports use the same one-use server projectile evidence as bot
   * asteroid reports. The client may report where it saw the bot laser, but
   * it cannot create or replay the shot itself.
   */
  public consumeActiveBotLaserNearLoot(botId: string, lootId: string): boolean {
    const bot = this.entityManager.getEntity(botId);
    const loot = this.lootManager.get(lootId);
    if (bot?.type !== 'bot' || !loot) {
      return false;
    }

    const laser = this.lasers.find(
      (candidate) =>
        !candidate.hasExploded &&
        candidate.ownerId === botId &&
        isLaserNearAsteroid(candidate.position, loot.position, loot.radius)
    );
    if (!laser) {
      return false;
    }

    laser.hasExploded = true;
    return true;
  }

  /**
   * Consume one server-tracked human shot when its live geometry is near a
   * target. A report may omit its hit position for legacy clients; the server
   * still requires the tracked laser itself to be near the authoritative
   * target before consuming it.
   */
  public consumeHumanLaserNearTarget(
    attackerId: string,
    targetPosition: Position,
    targetRadius: number,
    reportedPosition?: Position
  ): boolean {
    if (
      !this.validatePosition(targetPosition) ||
      !Number.isFinite(targetRadius) ||
      targetRadius < 0 ||
      (reportedPosition !== undefined && !this.validatePosition(reportedPosition))
    ) {
      return false;
    }

    const shooter = this.entityManager.getEntity(attackerId);
    if (shooter?.type !== 'human') {
      return false;
    }

    const laser = this.lasers.find(
      (candidate) =>
        !candidate.hasExploded &&
        candidate.ownerId === attackerId &&
        (isLaserNearAsteroid(candidate.position, targetPosition, targetRadius) ||
          isLaserNearAsteroid(candidate.prevPosition, targetPosition, targetRadius)) &&
        (reportedPosition === undefined ||
          isLaserNearAsteroid(reportedPosition, targetPosition, targetRadius))
    );
    if (!laser) {
      return false;
    }
    laser.hasExploded = true;
    return true;
  }

  /** Consume one server-tracked human shot when its client hit report is near an EO hull. */
  public consumeHumanLaserNearSatellite(
    attackerId: string,
    satelliteId: string,
    reportedPosition: Position
  ): boolean {
    if (!this.validatePosition(reportedPosition)) {
      return false;
    }
    const satellite = this.satelliteManager.getSatellite(satelliteId);
    if (
      !satellite ||
      satellite.exploding ||
      satellite.respawnTimer > 0 ||
      satellite.health <= 0
    ) {
      return false;
    }

    return this.consumeHumanLaserNearTarget(
      attackerId,
      satellite.position,
      satellite.radius,
      reportedPosition
    );
  }

  /** Move live lasers and apply at most one break per asteroid / laser. */
  public advanceLasersAndResolveHits(): AppliedAsteroidHit[] {
    const hits: AppliedAsteroidHit[] = [];

    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined) {
        continue;
      }
      if (laser.hasExploded || Date.now() >= (this.humanLaserExpiry.get(laser) ?? Infinity)) {
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

      const hit = this.resolveLaserAgainstAsteroids(laser);
      if (hit) {
        hits.push(hit);
        this.lasers.splice(i, 1);
      }
    }

    return hits;
  }

  /** Immediate overlap check used when a shot is spawned on top of a roid. */
  public resolveSpawnedLaserHits(): AppliedAsteroidHit[] {
    const hits: AppliedAsteroidHit[] = [];
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined || laser.hasExploded) {
        continue;
      }
      const hit = this.resolveLaserAgainstAsteroids(laser);
      if (hit) {
        hits.push(hit);
        this.lasers.splice(i, 1);
      }
    }
    return hits;
  }

  private resolveLaserAgainstAsteroids(laser: ServerLaser): AppliedAsteroidHit | null {
    for (const asteroid of this.asteroidManager.getAllAsteroids()) {
      if (asteroid.isCollabTarget) {
        continue;
      }
      if (
        !checkLaserAsteroidCollisionSwept(
          laser.prevPosition,
          laser.position,
          asteroid.position,
          asteroid.size
        )
      ) {
        continue;
      }
      const hit = this.applyLaserAsteroidHit(asteroid.id, laser.ownerId, laser.position);
      laser.hasExploded = true;
      return hit.applied ? hit : null;
    }
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

  public queueCollabShockwave(origin: Position, now = Date.now()): void {
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

  public flushDueShockwaves(now = Date.now()): number {
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
      entities: allEntities.map(entity => ({
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
        respawnTimer: entity.respawnTimer,
        spawnProtectionTimer: entity.spawnProtectionTimer,
        kitId: entity.kitId,
        factionId: entity.factionId,
        abilityCooldownFrames: entity.abilityCooldownFrames,
        abilityActiveFrames: entity.abilityActiveFrames,
        shieldTimer: entity.shieldTimer,
        harpoonTimer: entity.harpoonTimer,
        harpoonTargetId: entity.harpoonTargetId,
        harpoonLatchPos: entity.harpoonLatchPos,
        deathCause: entity.deathCause || undefined,
        ...shieldSnapshot(entity),
      } satisfies ServerEntityData & Record<keyof ServerEntityData, unknown>)),
      asteroids: this.asteroidManager.getAllAsteroids(),
      loot: this.lootManager.getAll(),
      satellites: this.satelliteManager.getAllSatellites(),
      satellitePickups: this.satellitePickupManager.getAllPickups(),
      gameTime: this.gameTime,
      isPaused: this.isPaused,
      terrainSeed: getTerrainSeed(),
    } satisfies ServerGameState & Record<keyof ServerGameState, unknown>;
    
    // Debug logging for health values
    const humanPlayers = allEntities.filter(e => e.type === 'human');
    if (humanPlayers.length > 0) {
      logger.debug('GAME_STATE', 'Sending game state with health values', {
        players: humanPlayers.map(p => ({
          id: p.id,
          name: p.name,
          health: p.health,
          maxHealth: p.maxHealth,
          exploding: p.exploding,
          respawnTimer: p.respawnTimer
        }))
      });
    }
    
    return gameState;
  }

  private combatSidesAllowDamage(attackerId: string, targetId: string): boolean {
    if (
      !attackerId ||
      attackerId === 'asteroid' ||
      attackerId === 'boundary' ||
      attackerId === 'loot' ||
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
      })),
      entities: this.entityManager.getAllEntities().filter((other) => other.id !== entityId),
      playfieldScale: latchView?.playfieldScale,
      canvas: latchView?.canvas,
    };
    return activateAbilityOnHost(entity, world).activated;
  }

  public tickAbilities(): void {
    this.entityManager.tickAbilityState();
    const asteroids = this.asteroidManager.getAllAsteroids();
    const entities = this.entityManager.getAllEntities();
    for (const entity of entities) {
      pullHarpoonTarget(entity, [
        ...asteroids,
        ...entities.filter((other) => other.id !== entity.id),
      ]);
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
  public collectLoot(): Array<{ collectorId: string; lootId: string; mass: number }> {
    const collected = this.lootManager.collectOverlaps(this.entityManager.getAllEntities());
    const results: Array<{ collectorId: string; lootId: string; mass: number }> = [];
    for (const { collector, loot } of collected) {
      if (isFuelLoot(loot)) {
        applyFuelPickup(ensureFuelTank(collector), loot.fuel ?? 0);
        collector.lastUpdate = Date.now();
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
      collector.lastUpdate = Date.now();
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
    if (!shooter || shooter.exploding || shooter.health <= 0 || shooter.respawnTimer !== undefined) {
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
    entity.lastUpdate = Date.now();
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
      entity.lastUpdate = Date.now();
    }
  }

  // Bot-specific update methods for testing

  public updateBotMovement(): BotShot[] {
    const shots = this.entityManager.updateBotMovement();
    this.queueBotShots(shots);
    return shots;
  }

  public consumeBotShots(): BotShot[] {
    const shots = this.pendingBotShots;
    this.pendingBotShots = [];
    return shots;
  }

  private queueBotShots(shots: BotShot[]): void {
    for (const shot of shots) {
      const bot = this.entityManager.getEntity(shot.botId);
      if (bot?.type !== 'bot') {
        continue;
      }
      if (this.spawnLaser(shot.botId, shot.laserStart, shot.laserDirection)) {
        this.pendingBotShots.push(shot);
      }
    }
  }

  public getTerrainSeed(): number {
    return getTerrainSeed();
  }


  // Validation
  public validatePosition(position: any): { x: number; y: number } | null {
    if (!position || typeof position !== 'object') {
      return null;
    }

    const x = typeof position.x === 'number' ? position.x : (typeof position.x === 'string' ? parseFloat(position.x) : NaN);
    const y = typeof position.y === 'number' ? position.y : (typeof position.y === 'string' ? parseFloat(position.y) : NaN);

    if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
      return null;
    }

    return { x, y };
  }
}
