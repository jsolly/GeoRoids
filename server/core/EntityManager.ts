import type { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../shared/constants/health';
import { pickBalancedFactionFromShips } from '../../shared/factions';
import { createFuelTank } from '../../shared/fuel';
import { applyShipMass, GROWTH, resetShipMass } from '../../shared/shipGrowth';
import type {
  LaserUpgrade,
  PlayerMotionState,
  Position,
  ShipKitId,
  SoftFactionId,
  Velocity,
} from '../../shared-types';
import { DEBUG, FUEL, PALETTE, SHIP } from '../../src/constants';
import { parseSoftFactionId } from '../../src/entities/player/softFactions';
import { clearShieldProjection, tickAbilityHost } from '../../src/entities/ship/shipAbilities';
import {
  applyShipKitStats,
  DEFAULT_SHIP_KIT_ID,
  isShipKitId,
  SHIP_KIT_IDS,
} from '../../src/entities/ship/shipKits';
import {
  type CombatDamageSource,
  clearShield,
  createShieldState,
  maybeActivateBotShield,
  type ShieldState,
  updateShield,
} from '../../src/entities/ship/shipShield';
import { getAsteroidFieldRadius } from '../../src/physics/asteroidMotion';
import { applyShockwaveToBody } from '../../src/physics/shockwave';
import { BOT_AI, BotBrain, type BotShot, makeBotShot } from '../ai/botController';
import { applyShipMotionSteps, containShipInArena } from '../ai/shipMotion';
import type { RNGService } from './RNGService';

/** Keep lives/score after a dropped socket so the same id can rejoin. */
const HUMAN_REJOIN_STASH_TTL_MS = 5 * 60 * 1000;

interface HumanRejoinStash {
  lives: number;
  score: number;
  name: string;
  savedAt: number;
}

export interface GameEntity extends ShieldState {
  id: string;
  name: string;
  type: 'human' | 'bot';
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  thrusting: boolean;
  color: string;
  lives: number;
  score: number;
  health: number;
  maxHealth: number;
  /** Frames remaining before server-authoritative health regeneration resumes. */
  healthRegenTimer: number;
  fuel: number;
  maxFuel: number;
  mass: number;
  lastUpdate: number;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
  ws?: WebSocket; // Only for human players
  explodeTime?: number; // For bot explosion handling
  kitId: ShipKitId;
  factionId?: SoftFactionId;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  shieldTimer: number;
  shieldTargetId?: string;
  shieldSourceId?: string;
  harpoonTimer: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
  /** Killer of the current death (cleared on respawn). */
  deathCause?: string;
  asteroidInteractions?: 1;
  playerMotion?: PlayerMotionState;
  laserUpgrade?: LaserUpgrade;
}

export class EntityManager {
  private entities = new Map<string, GameEntity>();
  private rng: RNGService;
  private readonly now: () => number;
  private isCreatingBots = false;
  private humanRejoinStash = new Map<string, HumanRejoinStash>();
  private humanRejoinByName = new Map<string, HumanRejoinStash>();
  private readonly botBrain = new BotBrain();
  /** Old human id remapped by same-name takeover — consume after addHumanPlayer. */
  private replacedHumanId: string | undefined;

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

  public getHumanPlayers(): GameEntity[] {
    return Array.from(this.entities.values()).filter((entity) => entity.type === 'human');
  }

  public getEntityBySocket(ws: WebSocket): GameEntity | undefined {
    for (const entity of this.entities.values()) {
      if (entity.ws === ws) {
        return entity;
      }
    }
    return undefined;
  }

  public getBots(): GameEntity[] {
    return Array.from(this.entities.values()).filter((entity) => entity.type === 'bot');
  }

  public getHumanBySocket(ws: WebSocket): GameEntity | undefined {
    return this.getHumanPlayers().find((entity) => entity.ws === ws);
  }

  public getHumanPlayerCount(): number {
    return this.getHumanPlayers().length;
  }

  public getBotCount(): number {
    return this.getBots().length;
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

    // Apply other allowed properties. Shield timers are owned by requestShield /
    // updateShields — a stale client echo must not toggle them off.
    const {
      maxHealth: ignoredMaxHealth,
      health: ignoredHealth,
      mass: ignoredMass,
      healthRegenTimer: _ignoredHealthRegenTimer,
      maxFuel: _ignoredMaxFuel,
      fuel: _ignoredFuel,
      shieldActive: _ignoredShieldActive,
      shieldTime: _ignoredShieldTime,
      shieldCooldown: _ignoredShieldCooldown,
      shieldFlashTime: _ignoredShieldFlashTime,
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
      this.stashHumanForRejoin(entity);
      this.clearShieldProjectionLinks(entityId);
      this.entities.delete(entityId);
      logger.debug('ENTITY', 'Entity removed', { entityId, entityType: entity.type });
    }
    return entity;
  }

  private nextFaction(): SoftFactionId {
    return pickBalancedFactionFromShips(this.getAllEntities());
  }

  /** Clear every projection link touching a caster, recipient, or leaving ship. */
  private clearShieldProjectionLinks(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (!entity) {
      return;
    }
    if (entity.shieldSourceId) {
      const source = this.entities.get(entity.shieldSourceId);
      if (source?.shieldTargetId === entityId) {
        delete source.shieldTargetId;
        source.abilityActiveFrames = 0;
      }
    }
    for (const candidate of this.entities.values()) {
      if (candidate.id === entityId) {
        continue;
      }
      if (candidate.shieldTargetId === entityId) {
        delete candidate.shieldTargetId;
        candidate.abilityActiveFrames = 0;
      }
      if (candidate.shieldSourceId === entityId) {
        clearShieldProjection(candidate);
      }
    }
    clearShieldProjection(entity);
  }

  // Human player management
  public addHumanPlayer(
    id: string,
    name: string,
    ws: WebSocket,
    position?: Position,
    _color?: string,
    kitId?: ShipKitId,
    factionId?: SoftFactionId
  ): GameEntity {
    this.replacedHumanId = undefined;

    const existing = this.entities.get(id);
    if (existing && existing.type === 'human') {
      if (existing.lives > 0) {
        return this.attachLiveHuman(existing, id, name, ws, kitId);
      }
      // Leftover 0-life ship after game-over — Start must not rejoin it.
      this.clearShieldProjectionLinks(id);
      this.entities.delete(id);
    }

    const sameName = this.getHumanPlayers().find((human) => human.name === name);
    if (sameName && sameName.lives > 0) {
      return this.attachLiveHuman(sameName, id, name, ws, kitId);
    }
    if (sameName && sameName.lives <= 0) {
      this.clearShieldProjectionLinks(sameName.id);
      this.entities.delete(sameName.id);
    }

    const restored = this.consumeHumanRejoinStash(id, name);
    const entity: GameEntity = {
      id,
      name,
      type: 'human',
      position: position || { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      exploding: false,
      thrusting: false,
      color: PALETTE.REMOTE,
      lives: restored?.lives ?? 3,
      score: restored?.score ?? 0,
      health: 100,
      maxHealth: 100,
      healthRegenTimer: 0,
      ...createFuelTank(FUEL.START, FUEL.MAX),
      mass: GROWTH.BASE_MASS,
      lastUpdate: this.now(),
      spawnProtectionTimer: SHIP.INVINCIBILITY_DURATION_FRAMES,
      ...createShieldState(),
      ws,
      kitId: DEFAULT_SHIP_KIT_ID,
      factionId: parseSoftFactionId(factionId) ?? this.nextFaction(),
      abilityCooldownFrames: 0,
      abilityActiveFrames: 0,
      shieldTimer: 0,
      harpoonTimer: 0,
    };
    applyShipKitStats(entity, kitId ?? DEFAULT_SHIP_KIT_ID);

    this.addEntity(entity);
    return entity;
  }

  private applyRequestedKit(entity: GameEntity, kitId?: unknown): void {
    if (!isShipKitId(kitId)) {
      return;
    }
    applyShipKitStats(entity, kitId);
  }

  /** Id displaced by a same-name takeover. Call after addHumanPlayer. */
  public consumeReplacedHumanId(): string | undefined {
    const id = this.replacedHumanId;
    this.replacedHumanId = undefined;
    return id;
  }

  private isPendingShipRespawn(entity: GameEntity): boolean {
    return entity.exploding || entity.health <= 0 || entity.respawnTimer !== undefined;
  }

  /**
   * Attach a new socket to a living human. Mid-death reuse must finish
   * respawn so two-tab reconnect never inherits a corpse, zero-vel, or
   * leftover explode timer. Live flyers keep pose and velocity.
   */
  private attachLiveHuman(
    existing: GameEntity,
    id: string,
    name: string,
    ws: WebSocket,
    kitId?: unknown
  ): GameEntity {
    const oldWs = existing.ws;
    const oldId = existing.id;
    if (oldId !== id) {
      this.clearShieldProjectionLinks(oldId);
      this.entities.delete(oldId);
      existing.id = id;
      this.entities.set(id, existing);
      this.replacedHumanId = oldId;
    }
    existing.ws = ws;
    existing.name = name;
    existing.lastUpdate = this.now();
    if (!existing.factionId) {
      existing.factionId = this.nextFaction();
    }
    this.applyRequestedKit(existing, kitId);
    if (this.isPendingShipRespawn(existing) && this.shouldScheduleRespawn(existing)) {
      this.respawnShip(existing);
    }
    if (oldWs && oldWs !== ws) {
      try {
        oldWs.close();
      } catch (error) {
        logger.error('ENTITY_REBIND_SOCKET_CLOSE_FAILED', {
          oldPlayerId: oldId,
          newPlayerId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return existing;
  }

  private stashHumanForRejoin(entity: GameEntity): void {
    if (entity.type !== 'human' || entity.lives <= 0) {
      return;
    }
    const stash: HumanRejoinStash = {
      lives: entity.lives,
      score: entity.score,
      name: entity.name,
      savedAt: this.now(),
    };
    this.humanRejoinStash.set(entity.id, stash);
    this.humanRejoinByName.set(entity.name, stash);
  }

  private consumeHumanRejoinStash(id: string, name?: string): HumanRejoinStash | undefined {
    const stash =
      this.humanRejoinStash.get(id) ?? (name ? this.humanRejoinByName.get(name) : undefined);
    if (!stash) {
      return undefined;
    }
    for (const [key, value] of this.humanRejoinStash) {
      if (value === stash || key === id) {
        this.humanRejoinStash.delete(key);
      }
    }
    this.humanRejoinByName.delete(stash.name);
    if (name) {
      this.humanRejoinByName.delete(name);
    }
    if (this.now() - stash.savedAt > HUMAN_REJOIN_STASH_TTL_MS) {
      return undefined;
    }
    return stash;
  }

  // Bot management
  public createBots(count: number, bounds = { radius: getAsteroidFieldRadius() }): GameEntity[] {
    // Clear existing bots
    const existingBots = this.getBots();
    for (const bot of existingBots) {
      this.removeEntity(bot.id);
    }

    const botNames = [
      'Crimson Falcon',
      'Nebula Viper',
      'Quantum Ranger',
      'Cosmic Specter',
      'Lunar Guardian',
      'Solar Sentinel',
      'Galactic Hunter',
      'Star Warden',
      'Nova Enforcer',
      'Meteor Striker',
    ];

    // Use DEBUG bot count if available
    const botCount = DEBUG.BOT_PLAYER.COUNT ?? count;

    // Use a separate seed sequence for bots to avoid interference with asteroids
    const originalState = this.rng.getState();
    this.rng.setState(0x9e3779b9 + 0x12345678); // Different seed for bots

    const newBots: GameEntity[] = [];

    for (let i = 0; i < Math.min(botCount, botNames.length); i++) {
      const botId = `server-bot-${i}`;
      // Generate random position within circular boundary
      const angle = this.rng.random() * Math.PI * 2;
      const radius = this.rng.random() * bounds.radius * 0.8; // Stay within 80% of boundary
      const position = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };

      const botName = botNames[i];
      if (botName === undefined) {
        continue;
      }

      const bot: GameEntity = {
        id: botId,
        name: botName,
        type: 'bot',
        position,
        velocity: { x: 0, y: 0 },
        angle,
        exploding: false,
        thrusting: false,
        color: PALETTE.BOT,
        lives: 3,
        score: 0,
        health: 100,
        maxHealth: 100,
        healthRegenTimer: 0,
        ...createFuelTank(FUEL.START, FUEL.MAX),
        mass: GROWTH.BASE_MASS,
        lastUpdate: this.now(),
        spawnProtectionTimer: SHIP.INVINCIBILITY_DURATION_FRAMES,
        kitId: DEFAULT_SHIP_KIT_ID,
        factionId: this.nextFaction(),
        abilityCooldownFrames: 0,
        abilityActiveFrames: 0,
        shieldTimer: 0,
        harpoonTimer: 0,
        ...createShieldState(),
      };
      applyShipKitStats(bot, SHIP_KIT_IDS[i % SHIP_KIT_IDS.length]);

      this.addEntity(bot);
      newBots.push(bot);
    }

    // Restore original RNG state
    this.rng.setState(originalState);

    return newBots;
  }

  // Damage system — projectile resolution reflects at shields; direct
  // collision/damage calls stay independent from visual shield state.
  public damageEntity(
    entityId: string,
    damage: number,
    _source: CombatDamageSource = 'collision'
  ): GameEntity | null {
    const entity = this.entities.get(entityId);
    if (!entity || entity.exploding || entity.health <= 0) {
      return null;
    }

    // Check spawn protection for both humans and bots
    if (entity.spawnProtectionTimer !== undefined && entity.spawnProtectionTimer > 0) {
      if (entity.type === 'bot') {
        // Bot spawn protection can be disabled via debug flag
        if (DEBUG.BOT_PLAYER.SPAWN_PROTECTION) {
          return null;
        }
      } else {
        // Humans always have spawn protection when timer > 0
        return null;
      }
    }

    const previousHealth = entity.health;
    const wasAlive = previousHealth > 0;
    entity.health = Math.max(0, entity.health - damage);
    if (entity.health < previousHealth) {
      entity.healthRegenTimer = calculateHealthRegenDelayFrames();
    }

    // If entity is destroyed, set exploding state
    if (entity.health <= 0 && wasAlive) {
      entity.exploding = true;
      // Set explosion timer for all entity types
      entity.explodeTime = SHIP.EXPLODE_DURATION_FRAMES;
      this.clearShieldProjectionLinks(entity.id);
      clearShield(entity);
    }

    entity.lastUpdate = this.now();
    return entity;
  }

  private shouldScheduleRespawn(entity: GameEntity): boolean {
    return entity.type === 'bot' || entity.lives > 0;
  }

  /**
   * One schedule for humans and bots. Do not reset an existing countdown
   * (that stacked a second wait and felt like freeze-stick). Last-life
   * humans stay dead; bots always come back.
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

  // Shared ship respawn for humans and bots.
  public updateRespawns(): string[] {
    const finishedRespawning: string[] = [];

    for (const [entityId, entity] of this.entities) {
      if (entity.respawnTimer !== undefined) {
        if (entity.respawnTimer > 0) {
          entity.respawnTimer--;
        }

        if (entity.respawnTimer === 0) {
          // A leftover timer must not resurrect a human who already spent their last life.
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

  public updateShields(): void {
    for (const entity of this.entities.values()) {
      updateShield(entity);
      if (entity.type === 'bot') {
        maybeActivateBotShield(entity, Math.random);
      }
    }
  }

  /** Tick the shared server-owned health regeneration clock for every ship. */
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
    entity.fuel = FUEL.START;
    entity.maxFuel = FUEL.MAX;
    entity.exploding = false;
    delete entity.explodeTime;
    delete entity.deathCause;
    this.clearShieldProjectionLinks(entity.id);
    clearShield(entity);
    this.placeEntityInArena(entity);
    entity.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
  }

  private placeEntityInArena(entity: GameEntity, boundsRadius = getAsteroidFieldRadius()): void {
    const respawnRadius = boundsRadius * 0.8;
    const angle = this.rng.random() * Math.PI * 2;
    const radius = this.rng.random() * respawnRadius;
    entity.position = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
    entity.angle = this.rng.random() * Math.PI * 2;
    entity.velocity = { x: 0, y: 0 };
  }

  // Controller-driven bot step. Same hull physics as players; only the brain is unique.
  public updateBotMovement(): BotShot[] {
    if (!DEBUG.BOT_PLAYER.MOVEMENT) {
      return [];
    }

    const bots = this.getBots();
    this.botBrain.forgetMissing(bots.map((bot) => bot.id));

    if (bots.length > 0 && this.rng.random() < 0.002) {
      logger.info('🤖', `Updating movement for ${bots.length} bots`);
    }

    const humans = this.getHumanPlayers();
    const shots: BotShot[] = [];

    for (const bot of bots) {
      if (bot.exploding || bot.health <= 0 || bot.respawnTimer !== undefined) {
        continue;
      }

      const decision = this.botBrain.decide(bot, humans, this.rng);
      bot.angle = decision.angle;
      bot.thrusting = decision.thrusting;

      if (decision.fire) {
        shots.push(makeBotShot(bot));
      }

      applyShipMotionSteps(bot, BOT_AI.MOTION_STEPS);
      containShipInArena(bot);
      bot.lastUpdate = this.now();
    }

    return shots;
  }

  // Cleanup
  public cleanupStaleEntities(): string[] {
    const now = this.now();
    const removedEntities: string[] = [];

    for (const [entityId, entity] of this.entities) {
      // Only cleanup human players (bots are managed by server)
      if (entity.type === 'human' && now - entity.lastUpdate > 30000) {
        // 30 seconds
        this.removeEntity(entityId);
        removedEntities.push(entityId);
      }
    }

    return removedEntities;
  }

  // Atomic bot creation to prevent race conditions
  public createBotsSafely(
    count: number,
    bounds = { radius: getAsteroidFieldRadius() }
  ): GameEntity[] | null {
    if (this.isCreatingBots) {
      return null; // Already creating bots
    }

    this.isCreatingBots = true;
    try {
      if (this.getBotCount() === 0) {
        return this.createBots(count, bounds);
      }
      return null; // Bots already exist
    } finally {
      this.isCreatingBots = false;
    }
  }

  public tickAbilityState(): void {
    for (const entity of this.entities.values()) {
      tickAbilityHost(entity);
    }
  }

  public clearAll(): void {
    this.entities.clear();
    this.botBrain.clear();
  }
}
