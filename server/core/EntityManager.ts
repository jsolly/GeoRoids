import type { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../shared/constants/health';
import { FURNACES } from '../../shared/furnaces';
import { applyShipMass, GROWTH, resetShipMass } from '../../shared/shipGrowth';
import type {
  HaulerUtilityId,
  LaserUpgrade,
  PlayerMotionState,
  Position,
  ShipKitId,
  Velocity,
} from '../../shared-types';
import { PALETTE, SHIP } from '../../src/constants';
import { tickAbilityHost } from '../../src/entities/ship/shipAbilities';
import { applyShipKitStats, DEFAULT_SHIP_KIT_ID } from '../../src/entities/ship/shipKits';
import { applyShockwaveToBody } from '../../src/physics/shockwave';
import type { RNGService } from './RNGService';

/** Authoritative live ship state; GameEngine owns persisted pilot progress. */
export interface GameEntity {
  id: string;
  name: string;
  type: 'player';
  position: Position;
  velocity: Velocity;
  knockbackVelocityLimit?: number;
  angle: number;
  exploding: boolean;
  thrusting: boolean;
  boosting: boolean;
  color: string;
  lives: number;
  score: number;
  health: number;
  maxHealth: number;
  /** Frames remaining before server-authoritative health regeneration resumes. */
  healthRegenTimer: number;

  mass: number;
  lastUpdate: number;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
  ws?: WebSocket;
  explodeTime?: number;
  kitId: ShipKitId;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;

  harpoonTargetId: string | null;
  harpoonLatchPos?: Position;
  haulerUtility?: HaulerUtilityId;
  tapExtractFrames?: number;
  tapExtractCompleted?: boolean;
  /** Environmental cause of the current death (cleared on respawn). */
  deathCause?: string;
  asteroidInteractions?: 1;
  playerMotion?: PlayerMotionState;
  laserUpgrade?: LaserUpgrade;
}

export class EntityManager {
  private entities = new Map<string, GameEntity>();
  private rng: RNGService;
  private readonly now: () => number;

  constructor(rngService: RNGService, now: () => number = () => Date.now()) {
    this.rng = rngService;
    this.now = now;
  }

  // Entity management
  public addEntity(entity: GameEntity): void {
    this.entities.set(entity.id, entity);
    logger.debug('ENTITY', 'Entity added', { entityId: entity.id, entityType: entity.type });
  }

  public getEntity(entityId: string): GameEntity | undefined {
    return this.entities.get(entityId);
  }

  public getAllEntities(): GameEntity[] {
    return Array.from(this.entities.values());
  }

  public getEntityBySocket(ws: WebSocket): GameEntity | undefined {
    for (const entity of this.entities.values()) {
      if (entity.ws === ws) {
        return entity;
      }
    }
    return undefined;
  }

  /** Kick living ships away from a collab-split origin. Smaller ships move more. */
  public applyRadialImpulse(origin: Position, radius: number, impulse: number): number {
    let affected = 0;
    const shipSize = SHIP.SIZE / 2;
    for (const entity of this.entities.values()) {
      if (entity.exploding || entity.health <= 0 || entity.respawnTimer !== undefined) {
        continue;
      }
      const next = applyShockwaveToBody(
        { position: entity.position, velocity: entity.velocity, size: shipSize },
        origin,
        { radius, impulse }
      );
      if (next) {
        entity.velocity = next;
        affected += 1;
      }
    }
    return affected;
  }

  public updateEntity(entityId: string, updates: Partial<GameEntity>): GameEntity | undefined {
    const entity = this.entities.get(entityId);
    if (!entity) {
      return undefined;
    }

    // Ignore any updates to id since it's the Map key
    const { id: ignoredId, ...allowedUpdates } = updates;

    // Validate and apply mass first so maxHealth/health follow growth.
    if (typeof allowedUpdates.mass === 'number' && Number.isFinite(allowedUpdates.mass)) {
      applyShipMass(entity, allowedUpdates.mass);
    }

    // Validate and apply maxHealth first
    if (typeof allowedUpdates.maxHealth === 'number' && Number.isFinite(allowedUpdates.maxHealth)) {
      entity.maxHealth = Math.max(1, allowedUpdates.maxHealth);
    }

    // Validate and apply health, clamped to [0, entity.maxHealth]
    if (typeof allowedUpdates.health === 'number' && Number.isFinite(allowedUpdates.health)) {
      const previousHealth = entity.health;
      entity.health = Math.max(0, Math.min(entity.maxHealth, allowedUpdates.health));
      if (entity.health < previousHealth) {
        entity.healthRegenTimer = calculateHealthRegenDelayFrames();
      }
    }

    // Apply remaining internal updates after validating health and mass.
    const {
      maxHealth: ignoredMaxHealth,
      health: ignoredHealth,
      mass: ignoredMass,
      healthRegenTimer: _ignoredHealthRegenTimer,

      ...otherUpdates
    } = allowedUpdates;
    Object.assign(entity, otherUpdates);

    // Update lastUpdate timestamp
    entity.lastUpdate = this.now();

    return entity;
  }

  public removeEntity(entityId: string): GameEntity | undefined {
    const entity = this.entities.get(entityId);
    if (entity) {
      this.entities.delete(entityId);
      logger.debug('ENTITY', 'Entity removed', { entityId, entityType: entity.type });
    }
    return entity;
  }

  public addPlayer(
    id: string,
    name: string,
    ws: WebSocket,
    position?: Position,
    kitId?: ShipKitId
  ): GameEntity {
    if (this.entities.has(id)) {
      throw new Error(`Pilot ${id} already exists; resume it with its private token`);
    }

    const entity: GameEntity = {
      id,
      name,
      type: 'player',
      position: position ?? { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      exploding: false,
      thrusting: false,
      boosting: false,
      color: PALETTE.REMOTE,
      lives: 3,
      score: 0,
      health: 100,
      maxHealth: 100,
      healthRegenTimer: 0,

      mass: GROWTH.BASE_MASS,
      lastUpdate: this.now(),
      spawnProtectionTimer: SHIP.INVINCIBILITY_DURATION_FRAMES,
      ws,
      kitId: DEFAULT_SHIP_KIT_ID,
      abilityCooldownFrames: 0,
      abilityActiveFrames: 0,
      harpoonTargetId: null,
    };
    applyShipKitStats(entity, kitId ?? DEFAULT_SHIP_KIT_ID);

    this.addEntity(entity);
    return entity;
  }

  // Environmental damage is authoritative; unbounced crew lasers never enter this path.
  public damageEntity(entityId: string, damage: number): GameEntity | null {
    const entity = this.entities.get(entityId);
    if (!entity || entity.exploding || entity.health <= 0) {
      return null;
    }

    if (entity.spawnProtectionTimer !== undefined && entity.spawnProtectionTimer > 0) {
      return null;
    }

    const previousHealth = entity.health;
    const wasAlive = previousHealth > 0;
    entity.health = Math.max(0, entity.health - damage);
    if (entity.health < previousHealth) {
      entity.healthRegenTimer = calculateHealthRegenDelayFrames();
    }

    if (entity.health <= 0 && wasAlive) {
      entity.exploding = true;
      entity.explodeTime = SHIP.EXPLODE_DURATION_FRAMES;
      entity.boosting = false;
    }

    entity.lastUpdate = this.now();
    return entity;
  }

  private shouldScheduleRespawn(entity: GameEntity): boolean {
    return entity.lives > 0;
  }

  /**
   * Do not reset an existing countdown (that stacked a second wait and felt
   * like freeze-stick). Last-life pilots stay dead.
   */
  public scheduleShipRespawn(entity: GameEntity): void {
    if (entity.respawnTimer !== undefined) {
      return;
    }
    if (!this.shouldScheduleRespawn(entity)) {
      return;
    }
    entity.respawnTimer = SHIP.RESPAWN_DELAY_FRAMES;
  }

  // Shared ship explosion: tick the animation. Respawn is scheduled at death
  // for every ship; this only fills in if a kill path forgot to.
  public updateExplosions(): string[] {
    const finishedExploding: string[] = [];

    for (const [entityId, entity] of this.entities) {
      if (!entity.exploding || !entity.explodeTime || entity.explodeTime <= 0) {
        continue;
      }

      entity.explodeTime--;
      if (entity.explodeTime > 0) {
        continue;
      }

      entity.exploding = false;
      this.scheduleShipRespawn(entity);
      finishedExploding.push(entityId);
    }

    return finishedExploding;
  }

  // Shared ship respawn for living pilots.
  public updateRespawns(): string[] {
    const finishedRespawning: string[] = [];

    for (const [entityId, entity] of this.entities) {
      if (entity.respawnTimer !== undefined) {
        if (entity.respawnTimer > 0) {
          entity.respawnTimer--;
        }

        if (entity.respawnTimer === 0) {
          // A leftover timer must not resurrect a player who already spent their last life.
          if (!this.shouldScheduleRespawn(entity)) {
            delete entity.respawnTimer;
            continue;
          }

          this.respawnShip(entity);
          finishedRespawning.push(entityId);
          logger.debug('ENTITY', 'Entity respawned', {
            entityId,
            entityType: entity.type,
            health: entity.health,
            position: entity.position,
            spawnProtection: entity.spawnProtectionTimer,
          });
          continue;
        }
      }

      if (entity.spawnProtectionTimer !== undefined) {
        if (entity.spawnProtectionTimer > 0) {
          entity.spawnProtectionTimer--;
        }

        if (entity.spawnProtectionTimer === 0) {
          delete entity.spawnProtectionTimer;
        }
      }
    }

    return finishedRespawning;
  }

  public updateHealthRegeneration(): number {
    const regenPerFrame = calculateHealthRegenPerFrame();
    let healedEntities = 0;

    for (const entity of this.entities.values()) {
      if (
        entity.exploding ||
        entity.health <= 0 ||
        entity.respawnTimer !== undefined ||
        entity.health >= entity.maxHealth
      ) {
        continue;
      }

      if (entity.healthRegenTimer > 0) {
        entity.healthRegenTimer--;
        continue;
      }

      const nextHealth = Math.min(entity.maxHealth, entity.health + regenPerFrame);
      if (nextHealth === entity.health) {
        continue;
      }
      entity.health = nextHealth;
      entity.lastUpdate = this.now();
      healedEntities++;
    }

    return healedEntities;
  }

  private respawnShip(entity: GameEntity): void {
    delete entity.respawnTimer;
    resetShipMass(entity);
    applyShipKitStats(entity, entity.kitId);
    entity.health = entity.maxHealth;
    entity.healthRegenTimer = 0;

    entity.exploding = false;
    entity.boosting = false;
    delete entity.explodeTime;
    delete entity.deathCause;

    this.placeEntityInArena(entity);
    entity.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
  }

  private placeEntityInArena(entity: GameEntity): void {
    const station = FURNACES.reduce((nearest, site) =>
      !nearest ||
      Math.hypot(site.position.x - entity.position.x, site.position.y - entity.position.y) <
        Math.hypot(nearest.position.x - entity.position.x, nearest.position.y - entity.position.y)
        ? site
        : nearest
    );
    const angle = this.rng.random() * Math.PI * 2;
    entity.position = {
      x: (station?.position.x ?? 0) + Math.cos(angle) * 180,
      y: (station?.position.y ?? 0) + Math.sin(angle) * 180,
    };
    entity.angle = this.rng.random() * Math.PI * 2;
    entity.velocity = { x: 0, y: 0 };
    delete entity.knockbackVelocityLimit;
  }

  /**
   * Return stale player IDs for the engine to remove through its lifecycle.
   * EntityManager cannot perform that removal itself because the engine owns
   * motion sessions, persistence capture, and pause transitions.
   */
  public getStalePlayerIds(): string[] {
    const now = this.now();
    const staleIds: string[] = [];

    for (const [entityId, entity] of this.entities) {
      if (now - entity.lastUpdate > 30000) {
        staleIds.push(entityId);
      }
    }

    return staleIds;
  }

  public tickAbilityState(): void {
    for (const entity of this.entities.values()) {
      tickAbilityHost(entity);
    }
  }

  public clearAll(): void {
    this.entities.clear();
  }
}
