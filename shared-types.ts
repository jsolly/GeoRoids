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

/** The server-owned predator state rendered by every client. */
export interface TerrainSpider {
  id: string;
  position: Position;
  angle: number;
  health: number;
  maxHealth: number;
  phase: 'scuttling' | 'hunting';
  shudderFrames?: number;
  probe?: AsteroidProbe | null;
  targetId: string | null;
}

export interface SpiderFieldState {
  consumed?: { id: string; position: Position; furnaceId: string; frame: number }[];
  spiders: TerrainSpider[];
  /** Known nest homes whose original stationary resource is still present. */
  nests: { id: string; resourceId: string; position: Position }[];
}

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
export type ShipKitId = 'scout' | 'hauler';

/** Hauler v1 utility slot. Same E key; one option active. */
export type HaulerUtilityId = 'resource_tap' | 'tow_cable' | 'boost_coupling';

/** Scout v1 utility slot. Same E key; one option active. */
export type ScoutUtilityId = 'mineral_scan' | 'survey_probe';

export interface AbilityUsedEvent {
  id: string;
  kitId: ShipKitId;
  abilityId: 'harpoon' | 'surveyScan';
  harpoonTargetId?: string | null;
  harpoonLatchPos?: Position;
  abilityActiveFrames: number;
  /** Present only on an accepted ignition, never on a snapshot or ordinary release. */
  boostIgnitionPosition?: Position;
}

export interface PlayerUpdate {
  id: string;
  position: Position;
  velocity: Velocity;
  angle: number;
  thrusting: boolean;
  boosting?: boolean;
  boostDepleted?: boolean;
  /** True while the local map or schematic holds this hull still. */
  overlayHold?: boolean;
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

/** Server-owned coupling; guidance points at the nearest furnace. */
export type AsteroidBoost =
  | { phase: 'armed'; ownerId: string; angle: number; couplings?: string[] }
  | { phase: 'burning'; ownerId: string; angle: number; couplings?: string[] };

/** Transient Scout hardware attached to one asteroid face. */
export interface AsteroidProbe {
  id: string;
  ownerId: string;
  health: number;
  maxHealth: number;
  attachedAt: number;
  expiresAt: number;
  /** Angular offset from the host asteroid's current rotation. */
  angle: number;
  /** Radial distance from the host asteroid center in world units. */
  radialOffset: number;
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
  /** Pilots who identified this deposit by scan or satellite; retained until it leaves the field. */
  surveyedBy?: string[];
  /** Pilots who have mined this deposit; persisted until the deposit is destroyed. */
  miningContributors?: string[];
  /** High-HP rock that stacks hits from every pilot (voluntary coop). */
  isCollabTarget?: boolean;
  phenomenon?: AsteroidPhenomenon;
  boost?: AsteroidBoost | null;
  /** Explicit null clears a previously rendered probe from client state. */
  probe?: AsteroidProbe | null;
}

/** Shared world pickups. Kill loot is wreckage; destroy-drop is shard; Tap extract is tap. */
export type EquipmentId = 'resource_tap' | 'boost_coupling' | 'survey_probe';

export type LootKind = 'shard' | 'wreckage' | 'laserCore' | 'tap' | 'silk' | EquipmentId;

/** One accepted collection, emitted before the next world snapshot. */
export interface LootCollected {
  lootId: string;
  collectorId: string;
  kind: LootKind;
  position: Position;
}

/** One Resource Tap canister leaving the rock, independent of snapshot visibility. */
export interface TapEjected {
  lootId: string;
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
export type SatellitePickupState = 'loose' | 'stored' | 'orbiting' | 'broken';

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
  /** Remaining service life; deployment and impacts both consume health. */
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
  /** Furnace intake; clients shatter the outline in danger-red with a smoke poof. */
  consumedBy?: 'furnace';
}

export interface ShockwaveEvent {
  origin: Position;
  asteroidId?: string;
}

/** A street furnace a Scout lit with their own score. */
export interface CivicModule {
  id: string;
  builderName: string;
  /** Public pilot id of the Scout who paid. Absent on older unnamed streets. */
  builderId?: string;
}

export interface ServerGameState {
  /** Epoch milliseconds for client animation clocks. */
  serverTime?: number;
  /** Street furnaces the crew has lit, named for the Scout who paid. */
  civicModules?: CivicModule[];
  /** Server-owned terrain predators, pursuit targets, and remaining health. */
  spiderField?: SpiderFieldState;
  /** Shared explored minimap cells, encoded as a fixed-width hexadecimal bitset. */
  exploration: ExplorationTile[];
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
  kind: 'furnace' | 'foundation' | 'laserCore' | 'wreckage' | 'satellite';
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

export interface ShipBoostState {
  phase: 'idle' | 'active' | 'exhausted';
  charge: number;
}

export interface FurnaceTransit {
  sourceId: string;
  destinationId: string;
  startedAt: number;
  durationMs: number;
}

export interface ServerEntityData {
  furnaceTransit?: FurnaceTransit | null;
  /** Stored spider silk, retained across flights. */
  silk?: number;
  /** Salvaged tools owned by this pilot, retained across flights. */
  equipment?: EquipmentId[];
  id: string;
  name: string;
  type: 'player';
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  thrusting: boolean;
  /** Omitted only by servers predating the independently deployed boost update. */
  boost?: ShipBoostState;
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
  /** Equipped Hauler utility. Omitted on other kits. Missing means tow cable. */
  haulerUtility?: HaulerUtilityId;
  /** Equipped Scout utility. Omitted on other kits. Missing means mineral scan. */
  scoutUtility?: ScoutUtilityId;
  /** Last environmental cause (boundary, asteroid, or ricochet). Omitted after respawn. */
  deathCause?: string;
  playerMotion?: PlayerMotionState;
  laserUpgrade?: LaserUpgrade;
}

/** Optional monotonic probe identity; bare heartbeat messages remain supported. */
export interface PingMessage {
  type: 'ping';
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
