import { WebSocket } from 'ws';
import type { AsteroidMotionState, LaserUpgrade, Position, ShipKitId, SoftFactionId, Velocity } from '../../shared-types';
import { pickBalancedFactionFromShips } from '../../shared/factions';
import { parseSoftFactionId } from '../../src/entities/player/softFactions';
import { absorbDamageWithShield, tickAbilityHost } from '../../src/entities/ship/shipAbilities';
import { applyShipKitStats, DEFAULT_SHIP_KIT_ID, isShipKitId, SHIP_KIT_IDS } from '../../src/entities/ship/shipKits';
import {
  clearShield,
  createShieldState,
  maybeActivateBotShield,
  noteReadableShieldLaserHit,
  shouldBlockDamage,
  updateShield,
  type CombatDamageSource,
  type ShieldState,
} from '../../src/entities/ship/shipShield';
import { createFuelTank } from '../../shared/fuel';
import { calculateHealthRegenDelayFrames, calculateHealthRegenPerFrame } from '../../shared/constants/health';
import { BOT_AI, BotBrain, makeBotShot, type BotShot } from '../ai/botController';
import { applyShipMotionSteps, containShipInArena } from '../ai/shipMotion';
import { DEBUG, FUEL, PALETTE, SHIP } from '../../src/constants';
import { getAsteroidFieldRadius } from '../../src/physics/asteroidMotion';
import { applyShockwaveToBody } from '../../src/physics/shockwave';
import { GROWTH, applyShipMass, resetShipMass } from '../../shared/shipGrowth';
import { logger } from '../../setup/serverLogger';
import { RNGService } from './RNGService';

export const RESPAWN_ANCHOR_ACK_DISTANCE = 100;
/** Keep lives/score after a dropped socket so the same id can rejoin. */
export const HUMAN_REJOIN_STASH_TTL_MS = 5 * 60 * 1000;

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
  /** Server spawn point held until the client echoes a nearby transform. */
  respawnAnchor?: Position;
  ws?: WebSocket; // Only for human players
  explodeTime?: number; // For bot explosion handling
  kitId: ShipKitId;
  factionId?: SoftFactionId;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  shieldTimer: number;
  harpoonTimer: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
  /** Killer of the current death (cleared on respawn). */
  deathCause?: string;
  asteroidInteractions?: 1;
  asteroidMotion?: AsteroidMotionState;
  laserUpgrade?: LaserUpgrade;
}

/** True when a client update is still the death pose, not the new spawn. */
export function isStaleDeathPose(
  anchor: Position | undefined,
  position: Position | undefined
): boolean {
  if (!anchor || !position) {
    return false;
  }
  return Math.hypot(position.x - anchor.x, position.y - anchor.y) > RESPAWN_ANCHOR_ACK_DISTANCE;
}


export class EntityManager {
  private entities = new Map<string, GameEntity>();
  private rng: RNGService;
  private isCreatingBots = false;
  private humanRejoinStash = new Map<string, HumanRejoinStash>();
  private humanRejoinByName = new Map<string, HumanRejoinStash>();
  private readonly botBrain = new BotBrain();
  /** Old human id remapped by same-name takeover — consume after addHumanPlayer. */
  private replacedHumanId: string | undefined;

  constructor(rngService: RNGService) {
    this.rng = rngService;
  }

  // Entity management
  public addEntity(entity: GameEntity): void {
    this.entities.set(entity.id, entity);
    logger.debug('ENTITY', `Added ${entity.type} entity: ${entity.name} (${entity.id})`);
  }

  public getEntity(entityId: string): GameEntity | undefined {
    return this.entities.get(entityId);
  }

  public getAllEntities(): GameEntity[] {
    return Array.from(this.entities.values());
  }

  public getHumanPlayers(): GameEntity[] {
    return Array.from(this.entities.values()).filter(entity => entity.type === 'human');
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
    return Array.from(this.entities.values()).filter(entity => entity.type === 'bot');
  }

  public getHumanBySocket(ws: WebSocket): GameEntity | undefined {
    return this.getHumanPlayers().find((entity) => entity.ws === ws);
  }

  public getEntityCount(): number {
    return this.entities.size;
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
    entity.lastUpdate = Date.now();

    return entity;
  }

  public removeEntity(entityId: string): GameEntity | undefined {
    const entity = this.entities.get(entityId);
    if (entity) {
      this.stashHumanForRejoin(entity);
      this.entities.delete(entityId);
      logger.debug('ENTITY', `Removed ${entity.type} entity: ${entity.name} (${entityId})`);
    }
    return entity;
  }

  private nextFaction(): SoftFactionId {
    return pickBalancedFactionFromShips(this.getAllEntities());
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
      this.entities.delete(id);
    }

    const sameName = this.getHumanPlayers().find((human) => human.name === name);
    if (sameName && sameName.lives > 0) {
      return this.attachLiveHuman(sameName, id, name, ws, kitId);
    }
    if (sameName && sameName.lives <= 0) {
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
      lastUpdate: Date.now(),
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
      this.entities.delete(oldId);
      existing.id = id;
      this.entities.set(id, existing);
      this.replacedHumanId = oldId;
    }
    existing.ws = ws;
    existing.name = name;
    existing.lastUpdate = Date.now();
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
      } catch {
        // Old tab or zombie socket; the close handler must not see this ws.
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
      savedAt: Date.now(),
    };
    this.humanRejoinStash.set(entity.id, stash);
    this.humanRejoinByName.set(entity.name, stash);
  }

  private consumeHumanRejoinStash(id: string, name?: string): HumanRejoinStash | undefined {
    const stash = this.humanRejoinStash.get(id) ?? (name ? this.humanRejoinByName.get(name) : undefined);
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
    if (Date.now() - stash.savedAt > HUMAN_REJOIN_STASH_TTL_MS) {
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
      'Crimson Falcon', 'Nebula Viper', 'Quantum Ranger', 'Cosmic Specter',
      'Lunar Guardian', 'Solar Sentinel', 'Galactic Hunter', 'Star Warden',
      'Nova Enforcer', 'Meteor Striker'
    ];

    // Use DEBUG bot count if available
    const botCount = DEBUG.BOT_PLAYER.COUNT ?? count;

    // Use a separate seed sequence for bots to avoid interference with asteroids
    const originalState = this.rng.getState();
    this.rng.setState(0x9E3779B9 + 0x12345678); // Different seed for bots

    const newBots: GameEntity[] = [];

    for (let i = 0; i < Math.min(botCount, botNames.length); i++) {
      const botId = `server-bot-${i}`;
      // Generate random position within circular boundary
      const angle = this.rng.random() * Math.PI * 2;
      const radius = this.rng.random() * bounds.radius * 0.8; // Stay within 80% of boundary
      const position = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
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
        lastUpdate: Date.now(),
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

  // Damage system — laser hits honor the shared shield; collisions do not.
  public damageEntity(
    entityId: string,
    damage: number,
    source: CombatDamageSource = 'collision'
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

    if (absorbDamageWithShield(entity)) {
      if (source === 'laser') {
        noteReadableShieldLaserHit(entity);
      }
      entity.lastUpdate = Date.now();
      return entity;
    }

    if (shouldBlockDamage(entity, source)) {
      noteReadableShieldLaserHit(entity);
      entity.lastUpdate = Date.now();
      return null;
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
      clearShield(entity);
    }

    entity.lastUpdate = Date.now();
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
            entity.respawnTimer = undefined;
            continue;
          }

          this.respawnShip(entity);
          finishedRespawning.push(entityId);
          logger.debug('ENTITY', `Respawned ${entity.type} entity: ${entity.name} (${entityId})`, {
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
          entity.spawnProtectionTimer = undefined;
          entity.respawnAnchor = undefined;
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
      entity.lastUpdate = Date.now();
      healedEntities++;
    }

    return healedEntities;
  }

  private respawnShip(entity: GameEntity): void {
    entity.respawnTimer = undefined;
    resetShipMass(entity);
    applyShipKitStats(entity, entity.kitId);
    entity.health = entity.maxHealth;
    entity.healthRegenTimer = 0;
    entity.fuel = FUEL.START;
    entity.maxFuel = FUEL.MAX;
    entity.exploding = false;
    entity.explodeTime = undefined;
    entity.deathCause = undefined;
    clearShield(entity);
    this.placeEntityInArena(entity);
    entity.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
    entity.respawnAnchor = { x: entity.position.x, y: entity.position.y };
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
      bot.lastUpdate = Date.now();
    }

    return shots;
  }

  // Cleanup
  public cleanupStaleEntities(): string[] {
    const now = Date.now();
    const removedEntities: string[] = [];

    for (const [entityId, entity] of this.entities) {
      // Only cleanup human players (bots are managed by server)
      if (entity.type === 'human' && now - entity.lastUpdate > 30000) { // 30 seconds
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

  public isCreating(): boolean {
    return this.isCreatingBots;
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
