import type {
  AsteroidData,
  AsteroidMaterial,
  AsteroidPhenomenon,
  LaserUpgrade,
  LootData,
  LootKind,
  MapAsset,
  PlayerMotionState,
  PlayerProjectileState,
  SatellitePickupData,
  SatellitePickupState,
  SatellitePickupTypeId,
  ServerEntityData,
  ServerGameSnapshot,
  ServerGameState,
  ShipKitId,
  SnapshotCollabTag,
} from '../shared-types';
import { validExploration } from './exploration';

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
  surveyor: true,
  hauler: true,
});
const lootKind = enumeration<LootKind>({
  shard: true,
  wreckage: true,

  laserCore: true,
});
const array =
  (rule: Rule): Rule =>
  (value) =>
    Array.isArray(value) && value.every(rule);
const shape = <T>(rules: Shape<T>): Rule => {
  const entries = Object.entries(rules) as Array<[string, Rule]>;
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const fields = value as Record<string, unknown>;
    return entries.every(([name, rule]) => rule(fields[name]));
  };
};
const position = shape<{ x: number; y: number }>({ x: number, y: number });
const energy: Rule = (value) => number(value) && (value as number) >= 0 && (value as number) <= 8;
const material = enumeration<AsteroidMaterial>({ ice: true, metal: true, rubble: true });
const motion = shape<PlayerMotionState>({
  epoch: counter,
  mode: choice('free', 'handoff'),
  ack: counter,
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
  type: choice('human'),
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

  mass: number,
  respawnTimer: optional(number),
  spawnProtectionTimer: optional(number),
  kitId: optional(kit),
  abilityCooldownFrames: optional(number),
  abilityActiveFrames: optional(number),

  harpoonTargetId: optional((value) => value === null || string(value)),
  harpoonLatchPos: optional(position),
  deathCause: optional(string),
  playerMotion: optional(motion),
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
  surveyedBy: optional(array(string)),
  miningContributors: optional(array(string)),
  phenomenon: optional(reflective),
});
const loot = shape<LootData>({
  id: string,
  position,
  mass: number,
  radius: number,
  kind: lootKind,
});
const pickup = shape<SatellitePickupData>({
  id: string,
  name: string,
  typeId: enumeration<SatellitePickupTypeId>({
    'landsat-7': true,
    terra: true,
    aqua: true,
    'goes-16': true,
    envisat: true,
    'worldview-3': true,
  }),
  assetKey: string,
  position,
  velocity: position,
  angle: number,
  radius: number,
  color: string,
  state: enumeration<SatellitePickupState>({ loose: true, orbiting: true, broken: true }),
  ownerId: (value) => value === null || string(value),
  health: number,
  maxHealth: number,
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
const mapAsset = shape<MapAsset>({
  id: string,
  kind: choice('furnace', 'laserCore', 'wreckage', 'satellite'),
  position,
  name: string,
});
const sectorIdentity: Rule = (value) => typeof value === 'string' && /^-?\d+,-?\d+$/.test(value);
const worldRules = {
  exploration: validExploration,
  completedSectors: array(sectorIdentity),
  mapAssets: array(mapAsset),
  entities: array(entity),
  asteroids: array(asteroid),
  loot: array(loot),
  satellitePickups: array(pickup),
  gameTime: number,
  isPaused: boolean,
  terrainSeed: optional(number),
} satisfies Shape<ServerGameState>;
const world = shape<ServerGameSnapshot>({
  ...worldRules,
  collabTags: array(collabTag),
  playerProjectiles: array(playerProjectile),
});
/** Validate one persisted asteroid with the same metadata rules used on the wire. */
export function validateAsteroidDto(value: unknown): asserts value is AsteroidData {
  if (!asteroid(value)) {
    throw new Error('Invalid asteroid DTO');
  }
}
/** Unknown JSON fields are preserved by the codec, never discarded by this validation. */
export function validateSnapshotDto(value: unknown): asserts value is ServerGameSnapshot {
  if (!world(value)) {
    throw new Error('Incomplete or invalid public snapshot DTO');
  }
  const snapshot = value as ServerGameSnapshot;
  const asteroidIds = new Set(snapshot.asteroids.map((item) => item.id));
  if (
    snapshot.collabTags.some(
      (item) => item.id !== item.asteroidId || !asteroidIds.has(item.asteroidId)
    )
  ) {
    throw new Error('Snapshot references a missing or invalid entity');
  }
}
