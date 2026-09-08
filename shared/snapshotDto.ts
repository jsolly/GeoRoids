import type {
  AsteroidData,
  AsteroidMaterial,
  AsteroidMotionState,
  AsteroidPhenomenon,
  LaserUpgrade,
  LootData,
  LootKind,
  PlayerProjectileState,
  SatelliteData,
  SatellitePickupData,
  SatellitePickupState,
  SatellitePickupTypeId,
  ServerEntityData,
  ServerGameSnapshot,
  ServerGameState,
  ShipKitId,
  SnapshotCollabTag,
  SnapshotSatelliteProjectile,
  SoftFactionId,
} from '../shared-types';
import type { SatelliteShotManner, SatelliteTypeId } from './eoSatellites';

type Rule = (value: unknown) => boolean;
/** Every DTO key must have a validator; additions cannot silently escape validation. */
type Shape<T> = { [K in keyof T]-?: Rule };
const number: Rule = (value) => typeof value === 'number' && Number.isFinite(value);
const string: Rule = (value) => typeof value === 'string';
const boolean: Rule = (value) => typeof value === 'boolean';
const counter: Rule = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const optional =
  (rule: Rule): Rule =>
  (value) =>
    value === undefined || rule(value);
const choice =
  (...values: string[]): Rule =>
  (value) =>
    typeof value === 'string' && values.includes(value);
const enumeration =
  <T extends string>(values: Record<T, true>): Rule =>
  (value) =>
    typeof value === 'string' && Object.hasOwn(values, value);
const kit = enumeration<ShipKitId>({
  dart: true,
  hauler: true,
  warden: true,
  skirmisher: true,
  quake: true,
});
const faction = enumeration<SoftFactionId>({ ion: true, ember: true });
const lootKind = enumeration<LootKind>({
  shard: true,
  wreckage: true,
  fuel: true,
  laserCore: true,
});
const array =
  (rule: Rule): Rule =>
  (value) =>
    Array.isArray(value) && value.every(rule);
const shape =
  <T>(rules: Shape<T>): Rule =>
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const fields = value as Record<string, unknown>;
    return Object.entries(rules).every(([name, rule]) => (rule as Rule)(fields[name]));
  };
const position = shape<{ x: number; y: number }>({ x: number, y: number });
const energy: Rule = (value) => number(value) && (value as number) >= 0 && (value as number) <= 8;
const material = enumeration<AsteroidMaterial>({ ice: true, metal: true, rubble: true });
const motion = shape<AsteroidMotionState>({
  epoch: counter,
  mode: choice('free', 'latched', 'released', 'handoff'),
  ack: counter,
  tetherMode: optional(choice('spin', 'anchor', 'brake')),
  asteroidId: optional(string),
  payloadId: optional(string),
  latchAngle: optional(number),
  anchor: optional(position),
});
const upgrade = shape<LaserUpgrade>({ charges: counter, expiresAt: number });
const reflective = shape<Extract<AsteroidPhenomenon, { kind: 'reflective' }>>({
  kind: choice('reflective'),
  clusterId: string,
  energy,
  maxEnergy: energy,
});
const entity = shape<ServerEntityData>({
  id: string,
  name: string,
  type: choice('human', 'bot'),
  position,
  velocity: position,
  angle: number,
  exploding: boolean,
  thrusting: boolean,
  color: string,
  lives: number,
  score: number,
  health: number,
  maxHealth: number,
  fuel: number,
  maxFuel: number,
  mass: number,
  respawnTimer: optional(number),
  spawnProtectionTimer: optional(number),
  kitId: optional(kit),
  factionId: optional(faction),
  abilityCooldownFrames: optional(number),
  abilityActiveFrames: optional(number),
  shieldTimer: optional(number),
  harpoonTimer: optional(number),
  harpoonTargetId: optional(string),
  harpoonLatchPos: optional(position),
  deathCause: optional(string),
  shieldActive: optional(boolean),
  shieldTime: optional(number),
  shieldCooldown: optional(number),
  shieldFlashTime: optional(number),
  asteroidMotion: optional(motion),
  laserUpgrade: optional(upgrade),
});
const asteroid = shape<AsteroidData>({
  id: string,
  position,
  velocity: position,
  size: number,
  jaggedness: number,
  rotation: number,
  angularVelocity: number,
  health: number,
  maxHealth: number,
  vertices: number,
  offsets: array(number),
  isCollabTarget: optional(boolean),
  material: optional(material),
  phenomenon: optional(reflective),
  spinClass: optional(choice('natural', 'charged')),
});
const loot = shape<LootData>({
  id: string,
  position,
  mass: number,
  radius: number,
  kind: lootKind,
  fuel: optional(number),
});
const satellite = shape<SatelliteData>({
  id: string,
  name: string,
  typeId: enumeration<SatelliteTypeId>({
    'landsat-7': true,
    terra: true,
    aqua: true,
    'goes-16': true,
    envisat: true,
    'worldview-3': true,
  }),
  assetKey: string,
  shotManner: enumeration<SatelliteShotManner>({
    'steady-optical-ping': true,
    'wide-modis-sweep': true,
    'microwave-spin-burst': true,
    'geo-weather-beam': true,
    'radar-plank-sweep': true,
    'sharp-vhr-stab': true,
  }),
  position,
  velocity: position,
  angle: number,
  exploding: boolean,
  color: string,
  health: number,
  maxHealth: number,
  radius: number,
});
const pickup = shape<SatellitePickupData>({
  id: string,
  name: choice('Echo', 'Relay'),
  typeId: enumeration<SatellitePickupTypeId>({ echo: true, relay: true }),
  assetKey: choice('pickup/echo', 'pickup/relay'),
  position,
  velocity: position,
  angle: number,
  radius: number,
  color: string,
  state: enumeration<SatellitePickupState>({ loose: true, orbiting: true }),
  ownerId: (value) => value === null || string(value),
  shieldFramesRemaining: number,
});
const projectile = shape<SnapshotSatelliteProjectile>({
  id: string,
  satelliteId: string,
  shotId: string,
  position,
  velocity: position,
  age: (value) => number(value) && (value as number) >= 0,
});
const playerProjectile = shape<PlayerProjectileState>({
  id: string,
  ownerId: string,
  position,
  prevPosition: position,
  velocity: position,
  energy,
  bounces: counter,
  age: counter,
});
const collabTag = shape<SnapshotCollabTag>({
  id: string,
  asteroidId: string,
  expiresAt: number,
  hits: array(
    shape<SnapshotCollabTag['hits'][number]>({ shooterId: string, at: number, points: number })
  ),
});
const legacyRules = {
  entities: array(entity),
  asteroids: array(asteroid),
  loot: array(loot),
  satellites: array(satellite),
  satellitePickups: array(pickup),
  gameTime: number,
  isPaused: boolean,
  terrainSeed: optional(number),
} satisfies Shape<ServerGameState>;
const world = shape<ServerGameSnapshot>({
  ...legacyRules,
  satelliteProjectiles: array(projectile),
  collabTags: array(collabTag),
  playerProjectiles: optional(array(playerProjectile)),
});
/** Unknown JSON fields are preserved by the codec, never discarded by this validation. */
export function validateSnapshotDto(value: unknown): asserts value is ServerGameSnapshot {
  if (!world(value)) {
    throw new Error('Incomplete or invalid public snapshot DTO');
  }
  const snapshot = value as ServerGameSnapshot;
  const satelliteIds = new Set(
    snapshot.satellites.filter((item) => !item.exploding && item.health > 0).map((item) => item.id)
  );
  const asteroidIds = new Set(snapshot.asteroids.map((item) => item.id));
  if (
    snapshot.satelliteProjectiles.some(
      (item) => item.id !== item.shotId || !satelliteIds.has(item.satelliteId)
    ) ||
    snapshot.collabTags.some(
      (item) => item.id !== item.asteroidId || !asteroidIds.has(item.asteroidId)
    )
  ) {
    throw new Error('Snapshot references a missing or invalid entity');
  }
}
