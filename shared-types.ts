// Shared types between client and server
// These types are used in network communication and should be identical on both sides

/** Soft sides for readability + same-side cooperation. Not a team win condition. */
export type FactionId = 'ion' | 'ember';

export type DiagnosticLogRecord = {
  version: 1;
  timestamp: string;
  source: 'client' | 'server';
  level: 'debug' | 'info' | 'warn' | 'error';
  releaseId: string;
  message: string;
  category?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  playerId?: string;
  connectionId?: string;
  receivedAt?: string;
  receiverReleaseId?: string;
};

// Common position and velocity types used throughout the system
export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  x: number;
  y: number;
}

// Network update interface - only what needs to be synced
/** Chosen at join. Shared by human and bot ships. Independent of soft faction. */
export type ShipKitId = 'dart' | 'hauler' | 'warden' | 'skirmisher' | 'quake';

/** Soft side (ION / EMBER). Assigned on join by the factions stream. */
export type SoftFactionId = 'ion' | 'ember';

export interface PlayerUpdate {
  id: string;
  name: string;
  position: Position;
  velocity: Velocity;
  r: number;
  angle: number;
  lives: number;
  score: number;
  exploding: boolean;
  health: number;
  maxHealth: number;
  fuel?: number;
  maxFuel?: number;
  kitId?: ShipKitId;
  factionId?: SoftFactionId;
  mass?: number;
  /** Acknowledges the server's current movement ownership epoch. */
  motionEpoch?: number;
  motionSequence?: number;
}

export interface PlayerJoin {
  /** Required current-protocol acknowledgement. */
  snapshotVersion: 1;
  asteroidInteractions: 1;
  /** Private to the joined socket; never included in world snapshots. */
  resumeToken: string;
  /** Private server build identifier for correlating client and server diagnostics. */
  serverReleaseId?: string;
  id: string;
  name: string;
  position: Position;
  color: string;
  kitId?: ShipKitId;
  factionId?: SoftFactionId;
  /** Seeded heightfield shared by every client in the room. */
  terrainSeed?: number;
}

export interface PlayerLeave {
  id: string;
}

// Game state types that might be shared
export type AsteroidMaterial = 'ice' | 'metal' | 'rubble';

export interface AsteroidPhenomenon {
  kind: 'reflective';
  clusterId: string;
  energy: number;
  maxEnergy: number;
}

export interface AsteroidMotionState {
  epoch: number;
  mode: 'free' | 'latched' | 'released' | 'handoff';
  ack: number;
  asteroidId?: string;
  payloadId?: string;
  latchAngle?: number;
  tetherMode?: 'spin' | 'anchor' | 'brake';
  anchor?: Position;
}

export interface AsteroidMotionInput {
  epoch: number;
  sequence: number;
  thrust: boolean;
  turn: -1 | 0 | 1;
  aimAngle: number;
  action?: 'release' | 'anchor' | 'brake' | 'spin';
  targetId?: string;
}

export interface AsteroidToolAction {
  action: 'latch';
  sequence: number;
  targetId?: string;
}

export interface LaserUpgrade {
  charges: number;
  expiresAt: number;
}

export interface PlayerProjectileState {
  id: string;
  ownerId: string;
  position: Position;
  prevPosition: Position;
  velocity: Velocity;
  energy: number;
  bounces: number;
  age: number;
}

export interface AsteroidData {
  id: string;
  position: Position;
  velocity: Velocity;
  size: number;
  jaggedness: number;
  rotation: number;
  angularVelocity: number;
  health: number;
  maxHealth: number;
  vertices: number;
  offsets: number[];
  /** Mineral composition when present on the asteroid. */
  material?: AsteroidMaterial;
  /** High-HP rock that stacks hits from every pilot (voluntary coop). */
  isCollabTarget?: boolean;
  phenomenon?: AsteroidPhenomenon;
  spinClass?: 'natural' | 'charged';
}

/** Shared world pickups. Kill loot is wreckage; destroy-drop is shard; fuel fills the EMP tank. */
export type LootKind = 'shard' | 'wreckage' | 'fuel' | 'laserCore';

export interface LootData {
  id: string;
  position: Position;
  mass: number;
  radius: number;
  kind: LootKind;
  fuel?: number;
}

/** Server-owned ambient hostile EO NPC. No kit, no soft faction. */
export interface SatelliteData {
  id: string;
  name: string;
  /** Stable roster identity used by both the renderer and server AI. */
  typeId: import('./shared/eoSatellites').SatelliteTypeId;
  /** Stable key for the six canonical EO hardware outlines. */
  assetKey: string;
  shotManner: import('./shared/eoSatellites').SatelliteShotManner;
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  color: string;
  health: number;
  maxHealth: number;
  radius: number;
}

export interface SatelliteShoot {
  id: string;
  /** One server-authored projectile identity; clients use it only for visuals. */
  shotId: string;
  laserStart: Position;
  laserDirection: Velocity;
}

export type SatellitePickupTypeId = 'echo' | 'relay';
export type SatellitePickupState = 'loose' | 'orbiting';

/** Server-owned collectible EO communications hardware. */
export interface SatellitePickupData {
  id: string;
  name: 'Echo' | 'Relay';
  typeId: SatellitePickupTypeId;
  /** Stable asset hook; pickups are distinct communications hardware. */
  assetKey: `pickup/${SatellitePickupTypeId}`;
  position: Position;
  velocity: Velocity;
  angle: number;
  radius: number;
  color: string;
  state: SatellitePickupState;
  ownerId: string | null;
  shieldFramesRemaining: number;
}

export interface SatellitePickupCollected {
  pickupId: string;
  playerId: string;
  playerName: string;
  pickupName: 'Echo' | 'Relay';
  scoreBonus: number;
  shieldFrames: number;
}

/** Server-owned collab tag. Clients must not destroy the roid until asteroidDestroy. */
export interface AsteroidTaggedEvent {
  asteroidId: string;
  shooterId: string;
  expiresAt: number;
}

/** Authoritative destroy. `origin` + `collabSplit` are the #447 shockwave hook. */
export interface AsteroidDestroyEvent {
  asteroidId: string;
  collabSplit?: boolean;
  origin?: Position;
}

export interface ShockwaveEvent {
  origin: Position;
  asteroidId?: string;
}

export interface ServerGameState {
  entities: ServerEntityData[];
  asteroids: AsteroidData[];
  loot: LootData[];
  satellites: SatelliteData[];
  satellitePickups: SatellitePickupData[];
  gameTime: number;
  isPaused: boolean;
  /** Same seed on every client → same contours and slope field. */
  terrainSeed?: number;
}

/** Public authoritative projectile state, shared by simulation, transport and client. */
export interface SatelliteProjectileState {
  satelliteId: string;
  shotId: string;
  position: Position;
  velocity: Velocity;
  age: number;
}

/** Complete collaborative hit window; omitted windows are no longer active. */
export interface ActiveCollabTag {
  asteroidId: string;
  hits: Array<{ shooterId: string; at: number; points: number }>;
  expiresAt: number;
}

export interface SnapshotSatelliteProjectile extends SatelliteProjectileState {
  /** Identical to shotId; enables the generic keyed collection delta. */
  id: string;
}

export interface SnapshotCollabTag extends ActiveCollabTag {
  /** Identical to asteroidId; enables explicit tag removals. */
  id: string;
}

/** Complete authoritative snapshot, including recovery state. */
export interface ServerGameSnapshot extends ServerGameState {
  satelliteProjectiles: SnapshotSatelliteProjectile[];
  collabTags: SnapshotCollabTag[];
  playerProjectiles: PlayerProjectileState[];
}

export interface ServerEntityData {
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
  fuel: number;
  maxFuel: number;
  mass: number;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
  kitId?: ShipKitId;
  factionId?: SoftFactionId;
  abilityCooldownFrames?: number;
  abilityActiveFrames?: number;
  shieldTimer?: number;
  harpoonTimer?: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
  /** Last killer token (boundary, asteroid, player/bot id). Omitted after respawn. */
  deathCause?: string;
  shieldActive?: boolean;
  shieldTime?: number;
  shieldCooldown?: number;
  shieldFlashTime?: number;
  asteroidMotion?: AsteroidMotionState;
  laserUpgrade?: LaserUpgrade;
}

/** Optional monotonic probe identity; bare heartbeat messages remain supported. */
export interface PingMessage {
  type: 'ping';
  timestamp?: number;
  probeId?: number;
}
export interface PongMessage {
  type: 'pong';
  timestamp: number;
  probeId?: number;
}
