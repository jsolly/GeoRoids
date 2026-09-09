/**
 * Consolidated Type Definitions
 * Central location for all application types
 */

// ============================================================================
// CORE GEOMETRY TYPES
// ============================================================================
export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  x: number;
  y: number;
}

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// ============================================================================
// ENTITY TYPES
// ============================================================================
export type EntityType = 'local' | 'remote' | 'bot';

export interface BaseEntity {
  readonly id: string;
  readonly position: Position;
  readonly velocity: Velocity;
  readonly angle: number;
  readonly size: number;
}

export interface Damageable {
  health: number;
  readonly maxHealth: number;
  readonly lastDamageTime: number;
  takeDamage(amount: number, cause?: string, killerName?: string): boolean;
  heal(amount: number): void;
}

export interface Movable {
  move(): void;
  setThrusting(thrusting: boolean): void;
  setAngularVelocity(velocity: number): void;
}

export interface Shootable {
  shoot(): void;
  canShoot(): boolean;
  readonly lasers: readonly Laser[];
}

// ============================================================================
// PLAYER TYPES
// ============================================================================
export interface Player extends BaseEntity {
  readonly name: string;
  readonly type: EntityType;
  readonly color: string;
  score: number;
  lives: number;
  readonly ship: Ship;
  readonly lastUpdate: number;
  readonly respawnTimer?: number;
  readonly spawnProtectedUntil: number;
  readonly isDead: boolean;
  update(): void;
  respawn(): void;
  onShipExploded(detail?: { cause?: string }): void;
}

// ============================================================================
// SHIP TYPES
// ============================================================================
export interface Ship extends BaseEntity, Damageable, Movable, Shootable {
  readonly angularVelocity: number;
  readonly thrusting: boolean;
  readonly thrusterActive: boolean;
  readonly blinkCount: number;
  readonly spawnProtectionTimer: number;
  readonly blinkOn: boolean;
  readonly exploding: boolean;
  readonly explodeTime: number;
  readonly fuel: number;
  readonly maxFuel: number;
  readonly shieldActive: boolean;
  readonly shieldTime: number;
  readonly shieldCooldown: number;
  readonly shieldFlashTime: number;
  readonly lastPosition?: Position;
  readonly lastRotation?: number;
  readonly isBot: boolean;

  setBlinkOn(): void;
  explode(): void;
  setExploding(): void;
  requestShieldToggle(): boolean;
  updateExplosion(): void;
  updateLifecycle(lifecycleFrames?: number): void;
  updateInvincibility(): void;
  canTakeCollisionDamage(cooldownMs?: number): boolean;
}

// ============================================================================
// LASER TYPES
// ============================================================================
export interface Laser extends BaseEntity {
  readonly hasExploded: boolean;
  readonly explodeTime: number;
  readonly distance: number;
  readonly maxDistance: number;
  readonly direction: Velocity;

  move(): void;
  shouldBeRemoved(): boolean;
  playLaserSound(): void;
  playHitSound(): void;
  updateExplodeTime(index: number): void;
}

// ============================================================================
// ASTEROID TYPES
// ============================================================================
export interface Roid extends BaseEntity {
  readonly vertices: number;
  readonly offsets: readonly number[];
  readonly jaggedness: number;
  readonly points: number;

  move(): void;
  render(ctx: CanvasRenderingContext2D): void;
}

export interface RoidBelt {
  roidNum: number;
  readonly roids: Roid[];
  readonly minCount: number;
  readonly maxCount: number;
  readonly initialCount: number;
  readonly spawnTimer: number;

  addRoid(): void;
  moveRoids(tickScale?: number): void;
  spawnRoids(): void;
  getRoids(): readonly Roid[];
  setRoidLimits(min: number, max: number): void;
}

// ============================================================================
// NETWORK TYPES
// ============================================================================
export interface NetworkPlayerUpdate {
  readonly id: string;
  readonly name: string;
  readonly position: Position;
  readonly velocity: Velocity;
  readonly r: number;
  readonly angle: number;
  readonly lives: number;
  readonly score: number;
  readonly exploding: boolean;
}

export interface NetworkPlayerJoin {
  readonly id: string;
  readonly name: string;
  readonly position: Position;
}

export interface NetworkPlayerLeave {
  readonly id: string;
}

export interface NetworkPlayerShoot {
  readonly id: string;
  readonly laserStart: Position;
  readonly laserDirection: Velocity;
}

export interface GameConfiguration {
  readonly lives: number;
  readonly fps: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly debug: boolean;
}

// ============================================================================
// SERVICE TYPES
// ============================================================================
export interface CollisionResult {
  readonly laserScore: number;
  readonly roidScore: number;
  readonly playerCollisionScore: number;
}

export interface Service {
  initialize?(): void;
  destroy?(): void;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

// ============================================================================
// EVENT TYPES
// ============================================================================
export interface CustomEventMap {
  gameStart: CustomEvent<undefined>;
  playerDied: CustomEvent<{
    playerId: string;
    deathCause: string;
    isGameOver: boolean;
  }>;
  shipExploded: CustomEvent<{
    shipId?: string;
    position?: Position;
    cause?: string;
    killerName?: string;
  }>;
  serverAsteroidTagged: CustomEvent<{
    asteroidId: string;
    shooterId: string;
    expiresAt: number;
  }>;
  serverAsteroidDestroyed: CustomEvent<{
    asteroidId: string;
    collabSplit?: boolean;
    origin?: Position;
  }>;
  serverShockwave: CustomEvent<{
    origin: Position;
    asteroidId?: string;
  }>;
  botShoot: CustomEvent<{
    laserStart: Position;
    laserDirection: Velocity;
  }>;
  satellitePickupCollected: CustomEvent<{
    pickupId: string;
    playerId: string;
    playerName: string;
    pickupName: 'Echo' | 'Relay';
    scoreBonus: number;
    shieldFrames: number;
  }>;
}

declare global {
  interface WindowEventMap extends CustomEventMap {}
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================
export interface GameConstants {
  readonly GAME: {
    readonly START_LIVES: number;
    readonly STARTING_SCORE: number;
    readonly BOT_COUNT: number;
    readonly FPS: number;
    readonly FRICTION: number;
  };

  readonly CANVAS: {
    readonly INTERNAL_WIDTH: number;
    readonly INTERNAL_HEIGHT: number;
    readonly DEFAULT_CENTER_X: number;
    readonly DEFAULT_CENTER_Y: number;
    readonly TEXT_SIZE: number;
    readonly TEXT_FADE_TIME: number;
  };

  readonly SHIP: {
    readonly TURN_SPEED: number;
    readonly THRUST: number;
    readonly MAX_VELOCITY: number;
    readonly BOT_FRICTION: number;
    readonly SIZE: number;
    readonly MAX_HEALTH: number;
    readonly COLLISION_DAMAGE: number;
    readonly HEALTH_REGEN_RATE: number;
    readonly HEALTH_REGEN_DELAY: number;
    readonly EXPLODE_DURATION_FRAMES: number;
    readonly INVINCIBILITY_DURATION_FRAMES: number;
    readonly INVINCIBILITY_BLINK_DURATION_FRAMES: number;
  };

  readonly LASER: {
    readonly SPEED: number;
    readonly MAX_COUNT: number;
    readonly TRAVEL_DISTANCE_RATIO: number;
    readonly EXPLODE_DURATION: number;
  };

  readonly ROID: {
    readonly SPEED: number;
    readonly SIZE: number;
    readonly VERTICES: number;
    readonly JAGGEDNESS: number;
    readonly POINTS_LARGE: number;
    readonly POINTS_MEDIUM: number;
    readonly POINTS_SMALL: number;
    readonly COLLAB_SPLIT_WINDOW_MS: number;
    readonly COLLAB_SPLIT_MIN_SIZE: number;
    readonly COLLAB_HIT_DEDUPE_MS: number;
    readonly INITIAL_ROID_COUNT: number;
    readonly MIN_COUNT: number;
    readonly MAX_COUNT: number;
    readonly SPAWN_TIME_FRAMES: number;
  };

  readonly SATELLITE: {
    readonly SIZE: number;
    readonly ORBIT_RADIUS: number;
    readonly ORBIT_SPEED: number;
    readonly DRIFT_SPEED: number;
    readonly SHOOT_INTERVAL_FRAMES: number;
    readonly AIM_JITTER: number;
    readonly AMBIENT_COUNT: number;
    readonly MAX_COUNT: number;
    readonly HEALTH: number;
    readonly POINTS: number;
    readonly COLLISION_DAMAGE: number;
    readonly DESPAWN_DISTANCE: number;
    readonly BOUNDARY_RADIUS: number;
    readonly EXPLODE_DURATION_FRAMES: number;
    readonly RESPAWN_FRAMES: number;
    readonly MASS: number;
  };

  readonly SHOCKWAVE: {
    readonly REFERENCE_SIZE: number;
    readonly MIN_SIZE: number;
    readonly MIN_SIZE_SCALE: number;
    readonly MAX_SIZE_SCALE: number;
    readonly SIZE_EXPONENT: number;
    readonly FAST: {
      readonly delayFrames: number;
      readonly durationFrames: number;
      readonly radius: number;
      readonly impulse: number;
      readonly strokeWidth: number;
    };
    readonly HEAVY: {
      readonly delayFrames: number;
      readonly durationFrames: number;
      readonly radius: number;
      readonly impulse: number;
      readonly strokeWidth: number;
    };
  };

  readonly FUEL: {
    readonly MAX: number;
    readonly START: number;
    readonly EMP_COST: number;
    readonly DROP_AMOUNT: number;
    readonly DROP_RADIUS: number;
    readonly MIN_ROID_SIZE_TO_DROP: number;
  };

  readonly SHIELD: {
    readonly DURATION_SECONDS: number;
    readonly COOLDOWN_SECONDS: number;
    readonly RADIUS_RATIO: number;
    readonly FLASH_SECONDS: number;
    readonly IDLE_ALPHA: number;
    readonly FLASH_ALPHA: number;
    readonly BOT_HEALTH_THRESHOLD: number;
    readonly BOT_ACTIVATE_CHANCE: number;
  };
}
