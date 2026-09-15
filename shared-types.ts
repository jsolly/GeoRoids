// Shared types between client and server
// These types are used in network communication and should be identical on both sides

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
/** Chosen at join. Shared by every player ship. */
export type ShipKitId = 'surveyor' | 'hauler';

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

  kitId?: ShipKitId;
  mass?: number;
  /** Acknowledges the server's current movement ownership epoch. */
  motionEpoch?: number;
  motionSequence?: number;
}

export interface PlayerJoin {
  /** Required current-protocol acknowledgement. */
  snapshotVersion: 1;
  asteroidInteractions: 1;
  /** The server accepts correlated shoot requests and emits per-shot acknowledgements. */
  shotAcknowledgements?: boolean;
  /** Private to the joined socket; never included in world snapshots. */
  resumeToken: string;
  /** Private server build identifier for correlating client and server diagnostics. */
  serverReleaseId?: string;
  /** Server release that issued this resume token. */
  credentialReleaseId?: string;
  /** Client release present when this resume token was issued. */
  credentialClientReleaseId?: string;
  /** Server clock when this resume token was issued. */
  credentialIssuedAt?: number;
  /** Server release that last wrote this pilot's score. */
  scoreReleaseId?: string;
  /** Client release present for a live score write. Omitted for server-only writes. */
  scoreClientReleaseId?: string;
  /** Server clock when this pilot's score was last written. */
  scoreUpdatedAt?: number;
  id: string;
  name: string;
  position: Position;
  color: string;
  kitId?: ShipKitId;
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

export interface PlayerMotionState {
  epoch: number;
  mode: 'free' | 'handoff';
  ack: number;
  anchor?: Position;
}

export interface LaserUpgrade {
  charges: number;
  expiresAt: number;
}

export interface PlayerProjectileState {
  /** Ability bolts do not consume the regular weapon limit. */

  id: string;
  ownerId: string;
  position: Position;
  prevPosition: Position;
  velocity: Velocity;
  energy: number;
  bounces: number;
  age: number;
}

/** Correlates a client-side predicted laser with its authoritative server entity. */
export interface PlayerShotAcknowledgement {
  requestId: string;
  projectileId: string | null;
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
  /** Surveyors who identified this deposit; retained until it leaves the field. */
  surveyedBy?: string[];
  /** Pilots who have mined this deposit; persisted until the deposit is destroyed. */
  miningContributors?: string[];
  /** High-HP rock that stacks hits from every pilot (voluntary coop). */
  isCollabTarget?: boolean;
  phenomenon?: AsteroidPhenomenon;
}

/** Shared world pickups. Kill loot is wreckage; destroy-drop is shard. */
export type LootKind = 'shard' | 'wreckage' | 'laserCore';

/** One accepted collection, emitted before the next world snapshot. */
export interface LootCollected {
  lootId: string;
  collectorId: string;
  kind: LootKind;
  position: Position;
}

export interface LootData {
  id: string;
  position: Position;
  mass: number;
  radius: number;
  kind: LootKind;
}

export type SatellitePickupTypeId = import('./shared/eoSatellites').SatelliteTypeId;
export type SatellitePickupState = 'loose' | 'orbiting' | 'broken';

/** Server-owned collectible Earth-observation hardware. */
export interface SatellitePickupData {
  id: string;
  name: string;
  typeId: SatellitePickupTypeId;
  /** Stable key for the six canonical EO hardware outlines. */
  assetKey: `eo/${SatellitePickupTypeId}`;
  position: Position;
  velocity: Velocity;
  angle: number;
  radius: number;
  color: string;
  state: SatellitePickupState;
  ownerId: string | null;
  health: number;
  maxHealth: number;
}

export interface SatellitePickupCollected {
  position: Position;
  pickupId: string;
  playerId: string;
  playerName: string;
  pickupName: string;
  scoreBonus: number;
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
  /** Shared explored minimap cells, encoded as a fixed-width hexadecimal bitset. */
  exploration: ExplorationTile[];
  /** Finished world sectors that stay walled off. */
  completedSectors: string[];
  /** Revealed landmarks and valuable drops, independent of local simulation visibility. */
  mapAssets: MapAsset[];
  entities: ServerEntityData[];
  asteroids: AsteroidData[];
  loot: LootData[];
  satellitePickups: SatellitePickupData[];
  gameTime: number;
  isPaused: boolean;
  /** Same seed on every client → same contours and slope field. */
  terrainSeed?: number;
}

export interface MapAsset {
  id: string;
  kind: 'furnace' | 'laserCore' | 'wreckage' | 'satellite';
  position: Position;
  name: string;
}

/** Complete collaborative hit window; omitted windows are no longer active. */
export interface ActiveCollabTag {
  asteroidId: string;
  hits: Array<{ shooterId: string; at: number; points: number }>;
  expiresAt: number;
}

export interface SnapshotCollabTag extends ActiveCollabTag {
  /** Identical to asteroidId; enables explicit tag removals. */
  id: string;
}

/** Complete authoritative snapshot, including recovery state. */
export interface ServerGameSnapshot extends ServerGameState {
  collabTags: SnapshotCollabTag[];
  playerProjectiles: PlayerProjectileState[];
}

export interface ServerEntityData {
  id: string;
  name: string;
  type: 'player';
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  thrusting: boolean;
  boosting?: boolean;
  color: string;
  lives: number;
  score: number;
  health: number;
  maxHealth: number;

  mass: number;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
  kitId?: ShipKitId;
  abilityCooldownFrames?: number;
  abilityActiveFrames?: number;

  harpoonTargetId?: string | null;
  harpoonLatchPos?: Position;
  /** Last environmental cause (boundary, asteroid, or ricochet). Omitted after respawn. */
  deathCause?: string;
  playerMotion?: PlayerMotionState;
  laserUpgrade?: LaserUpgrade;
}

/** Optional monotonic probe identity; bare heartbeat messages remain supported. */
export interface PingMessage {
  type: 'ping';
  timestamp?: number;
  probeId?: number;
}

/** One newly accepted ship shot; snapshots remain silent on join/reconnect. */
export type PlayerShotFired = Pick<PlayerProjectileState, 'id' | 'ownerId' | 'position'>;

/** One authoritative delivery, including the same full reward for each contributor. */
export interface FurnaceDelivery {
  furnaceId: string;
  asteroidId: string;
  position: Position;
  material: AsteroidMaterial;
  rewards: Array<{ playerId: string; playerName: string; points: number; score: number }>;
}

/** A sector of permanent shared map discoveries; 16 by 16 bits, hex encoded. */
export interface ExplorationTile {
  id: string;
  bits: string;
}
