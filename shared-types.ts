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
  /** Present only on spiders anchored to an asteroid belt deposit. */
  crawler?: {
    hostId: string;
    anchor: Position;
    phase: 'crawling' | 'winding' | 'lunging' | 'recovering' | 'escaping';
    progress: number;
  };
}

export interface SpiderFieldState {
  spiders: TerrainSpider[];
  /** Known nest homes whose original stationary resource is still present. */
  nests: { id: string; resourceId: string; position: Position; cleared: boolean }[];
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

/** Chosen at join. Shared by every player ship. */
export type ShipKitId = 'scout' | 'hauler';

/** Hauler v1 utility slot. Same E key; one option active. */
export type HaulerUtilityId = 'resource_tap' | 'tow_cable' | 'boost_coupling';

/** Scout v1 utility slot. Same E key; one option active. */
export type ScoutUtilityId = 'mineral_scan' | 'survey_probe';

/** Target pose at the start of a tool collision frame. */
export type ToolTargetPose = Position & { rotation?: number };

/** A single server-owned tool shot, carried by its pilot's snapshot row. */
export type UtilityFlight =
  | {
      kind: 'tow' | 'probe';
      phase: 'outbound';
      position: Position;
      velocity: Velocity;
      remainingDistance: number;
    }
  | { kind: 'tow'; phase: 'reeling'; position: Position; framesLeft: number }
  | { kind: 'probe'; phase: 'disintegrating'; position: Position; framesLeft: number };

export interface AbilityUsedEvent {
  id: string;
  kitId: ShipKitId;
  abilityId: 'harpoon' | 'surveyScan';
  harpoonTargetId?: string | null;
  harpoonLatchPos?: Position;
  utilityFlight?: UtilityFlight | null;
  abilityActiveFrames: number;
  /** Present only on an accepted ignition, never on a snapshot or ordinary release. */
  boostIgnitionPosition?: Position;
}

/** Highest complete snapshot applied on this physical gameplay socket. */
export interface SnapshotAcknowledgement {
  sequence: number;
}

export interface PlayerUpdate {
  id: string;
  position: Position;
  velocity: Velocity;
  angle: number;
  thrusting: boolean;
  contourLock?: ContourLockState | null;
  /** True while the local map or schematic holds this hull still. */
  overlayHold?: boolean;
  /** Acknowledges the server's current movement ownership epoch. */
  motionEpoch?: number;
  motionSequence?: number;
}

export interface PlayerJoin {
  /** Required current-protocol acknowledgement. */
  snapshotVersion: 3;
  asteroidInteractions: 1;
  /** This server accepts start/release/cancel charge commands. */
  chargedWeapons?: 1;
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
  terrainSeed: number;
}

export interface PlayerLeave {
  id: string;
}

// Game state types that might be shared
export type AsteroidMaterial = 'ice' | 'metal' | 'rubble' | 'crystal';

export interface SettlementState {
  level: number;
  points: number;
  resources: Record<AsteroidMaterial, number>;
}

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
  supply?: { sourceId: string; value: number };
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
  /** Attached belt crawler health; zero remains dead until the deposit regenerates. */
  beltCrawlerHealth?: number[];
  /** Stable identities follow crawlers to their new host after an escape. */
  beltCrawlerIds?: string[];
  /** Mineral composition when present on the asteroid. */
  material?: AsteroidMaterial;
  /** Null is barren. When absent, a stable deposit is derived from the rock id. */
  ore?: AsteroidMaterial | null;
  /** Pilots who identified this deposit by scan or satellite; retained until it leaves the field. */
  surveyedBy?: string[];
  /** Pilots who have mined this deposit; persisted until the deposit is destroyed. */
  miningContributors?: string[];
  phenomenon?: AsteroidPhenomenon;
  contourRider?: ContourLockState | null;
  /** Server-owned phosphorescent charge and one-time nearby hidden cache. */
  glowtoy?: { charge: number; cachePosition: Position; cacheRevealed: boolean };
  boost?: AsteroidBoost | null;
  /** Explicit null clears a previously rendered probe from client state. */
  probe?: AsteroidProbe | null;
}

/** Shared world pickups. Destroy-drop is shard; Tap extract is tap; mined cargo is points. */
export type EquipmentId = 'resource_tap' | 'boost_coupling' | 'survey_probe';

export type LootKind = 'shard' | 'tap' | 'silk' | EquipmentId | 'points';

/** One accepted collection, emitted before the next world snapshot. */
export interface LootCollected {
  /** Stable identity of this collection, optional while older servers remain deployed. */
  eventId?: string;
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

export interface SavedPointLoot {
  velocity?: Velocity;
  ejectFramesLeft?: number;
  id: string;
  position: Position;
  points: number;
  expiresAt: number;
}

export interface LootData {
  salvage?: AsteroidMaterial;
  points?: number;
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

/** Authoritative destruction and its world position. */
export interface AsteroidDestroyEvent {
  asteroidId: string;
  origin?: Position;
  /** Furnace intake; clients shatter the outline in danger-red with a smoke poof. */
  consumedBy?: 'furnace';
}

/**
 * A laser hit a durable deposit that survived it. Ordinary rocks report
 * `asteroidDestroy` instead, so a chip and a shatter never sound together.
 */
export interface AsteroidHitEvent {
  asteroidId: string;
  position: Position;
}

/** A furnace a Scout lit with their own score. */
export interface CivicModule {
  id: string;
  builderName: string;
  /** Public pilot id of the Scout who paid. Absent on older unnamed furnaces. */
  builderId?: string;
}

/** Neutral wildlife; it never participates in combat damage or loot. */
export interface RolyPolyState {
  id: string;
  position: Position;
  velocity: Velocity;
  phase: 'walking' | 'curled' | 'rolling';
}

export interface ContourBridge {
  id: string;
  ownerId: string;
  from: Position;
  to: Position;
  source: ContourLockState;
  target: ContourLockState;
  charged: boolean;
  framesLeft: number;
}
export interface ServerGameState {
  cooperativeActive?: boolean;
  campaign?: CampaignSnapshot;
  /** Epoch milliseconds for client animation clocks. */
  serverTime: number;
  settlement: SettlementState;
  /** Furnaces the crew has lit, named for the Scout who paid. */
  civicModules: CivicModule[];
  /** Server-owned terrain predators, pursuit targets, and remaining health. */
  spiderField: SpiderFieldState;
  rolyPolys?: RolyPolyState[];
  contourBridges?: ContourBridge[];
  beltRecovery: import('./shared/asteroidBelt').BeltRecoveryWarning[];
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
  terrainSeed: number;
}

export interface MapAsset {
  id: string;
  /** Snapshots call surviving point-cargo markers `wreckage`. */
  kind: 'furnace' | 'foundation' | 'wreckage' | 'satellite' | 'ship-remains' | 'nest-remains';
  position: Position;
  name: string;
}

/** Complete authoritative snapshot, including recovery state. */
export interface ServerGameSnapshot extends ServerGameState {
  playerProjectiles: PlayerProjectileState[];
}

export interface ContourLockState {
  height: number;
  direction: 1 | -1;
}

export interface FurnaceTransit {
  sourceId: string;
  destinationId: string;
  startedAt: number;
  durationMs: number;
}

export interface CrewSignal {
  kind: 'help' | 'nest';
  position: Position;
  expiresAt: number;
}
export type CrewAction =
  | { kind: 'revive'; targetId: string }
  | { kind: 'release' }
  | { kind: 'give-up' }
  | { kind: 'withdraw-supply' }
  | { kind: 'signal'; signal: 'help' | 'nest'; position: Position };
export interface RescueState {
  targetId: string;
  completesAt: number;
}

export type BotRole = 'worker' | 'raider';

export interface ServerEntityData {
  /** Server-controlled hull; omitted for human pilots. */
  botRole?: BotRole;
  downedUntil?: number | null;
  rescue?: RescueState | null;
  crewSignal?: CrewSignal | null;
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
  /** Omission means the pilot is not following a contour rail. */
  contourLock?: ContourLockState;
  color: string;
  cargo: number;
  /** Session cumulative accepted cargo deposits; independent of bank spending. */
  bankedCargo?: number;
  weaponChargeFrames?: number;
  navigationAssistFrames?: number;
  contourDraftFrames?: number;
  purchases: string[];
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
  utilityFlight?: UtilityFlight | null;
  /** Equipped Hauler utility. Omitted on other kits. Missing means tow cable. */
  haulerUtility?: HaulerUtilityId;
  /** Equipped Scout utility. Omitted on other kits. Missing means mineral scan. */
  scoutUtility?: ScoutUtilityId;
  playerMotion?: PlayerMotionState;
}

/** Optional monotonic probe identity; bare heartbeat messages remain supported. */
export interface PingMessage {
  type: 'ping';
  probeId?: number;
}

type EmptyData = Record<string, never>;

/** Every frame the gameplay client sends on `/ws`; the server still decodes each as untrusted. */
export type WeaponChargeAction = 'start' | 'release' | 'cancel';

export type ClientWireMessage =
  | {
      type: 'join';
      id: string;
      data: {
        name: string;
        position: Position;
        kitId: ShipKitId;
        snapshotVersion: 3;
        asteroidInteractions: 1;
        cooperativeVersion?: 1;
        worldRemains?: 1;

        clientReleaseId: string;
        resumeToken?: string;
      };
    }
  | { type: 'update'; data: PlayerUpdate }
  | {
      type: 'shoot';
      id: string;
      data: { laserStart: Position; laserDirection: Velocity; requestId: string };
    }
  | { type: 'snapshotAck'; data: SnapshotAcknowledgement }
  | { type: 'snapshotResync'; data: EmptyData }
  | { type: 'leave'; data: EmptyData }
  | { type: 'crewAction'; id: string; data: CrewAction }
  | { type: 'useAbility'; id: string; data: EmptyData }
  | { type: 'chargeWeapon'; id: string; data: { action: WeaponChargeAction } }
  | { type: 'setHaulerUtility'; id: string; data: { utilityId: HaulerUtilityId } }
  | { type: 'setScoutUtility'; id: string; data: { utilityId: ScoutUtilityId } }
  | { type: 'equipSatellite'; id: string; data: { pickupId: string } }
  | { type: 'buyStoreItem'; id: string; data: { offerId: string } }
  | { type: 'travelFurnace'; id: string; data: { destinationId: string } }
  | PingMessage;

/** Commands a pilot may send only after the server acknowledged its join. */
export type ClientGameplayMessage = Extract<
  ClientWireMessage,
  {
    type:
      | 'crewAction'
      | 'useAbility'
      | 'chargeWeapon'
      | 'setHaulerUtility'
      | 'setScoutUtility'
      | 'equipSatellite'
      | 'buyStoreItem'
      | 'travelFurnace'
      | 'snapshotResync';
  }
>;

/** One newly accepted ship shot; snapshots remain silent on join/reconnect. */
export type PlayerShotFired = Pick<PlayerProjectileState, 'id' | 'ownerId' | 'position'> & {
  charged?: boolean;
};

/** One authoritative delivery, including the same full reward for each contributor. */
export interface FurnaceDelivery {
  furnaceId: string;
  asteroidId: string;
  position: Position;
  material: AsteroidMaterial;
  rewards: Array<{ playerId: string; playerName: string; points: number }>;
}

/** A sector of permanent shared map discoveries; 16 by 16 bits, hex encoded. */
export interface ExplorationTile {
  id: string;
  bits: string;
}

/** Additive campaign state. IDs are stable across sector sleep and server restart. */
export type CooperativeRecord =
  | { kind: 'supply'; id: string; availableValue: number; nextShipment: number }
  | {
      kind: 'hive';
      id: string;
      position: Position;
      frontier: 'initial' | 'expanded';
      queenHealth: number;
      /** Active simulation frames until the next birth; offline time never births children. */
      birthFramesLeft: number;
      clearedAt: number | null;
      sacs: number[];
      sacDeadline: number | null;
      sacsCompletedAt: number | null;
      restoredValue: number;
      contributors: string[];
      commissionedAt: number | null;
    }
  | { kind: 'project'; id: 'deep-scanner'; deliveredValue: number; completedAt: number | null }
  | {
      kind: 'downed';
      id: string;
      position: Position;
      deadline: number;
      cause: string;
    };

export interface CooperativeWorld {
  schemaVersion: 1;
  activated: boolean;
  records: CooperativeRecord[];
}

export interface HazardPhase {
  phase: 'quiet' | 'warning' | 'active';
  kind: 'swarm' | 'meteors';
  startsAt: number;
  endsAt: number;
}
export interface CampaignSnapshot {
  projectValue: number;
  supplies: { id: string; value: number }[];
  hives: (Extract<CooperativeRecord, { kind: 'hive' }> & { shieldOpen: boolean })[];
  commissioned: string[];
  cleared: string[];
  hazard: HazardPhase;
  meteors: { id: string; position: Position }[];
}
/** Explicit JSON values crossing the debug-report boundary. */
export type DebugJsonValue =
  | null
  | boolean
  | number
  | string
  | DebugJsonValue[]
  | { [key: string]: DebugJsonValue };

export interface DebugDiagnosticSnapshot {
  state: { [key: string]: DebugJsonValue };
  recentLogs: string[];
}

export interface DebugReportSubmission {
  version: 1;
  id: string;
  receiptToken: string;
  description: string;
  submittedAt: string;
  diagnostics: DebugDiagnosticSnapshot;
}

export type DebugReportState = 'pending' | 'delivered' | 'blocked';

export interface DebugReportReceipt {
  id: string;
  state: DebugReportState;
}
