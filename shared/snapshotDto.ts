import type {
  AsteroidBoost,
  AsteroidData,
  AsteroidMaterial,
  AsteroidPhenomenon,
  AsteroidProbe,
  HaulerUtilityId,
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
  SpiderFieldState,
  TerrainSpider,
} from '../shared-types';
import type { BeltRecoveryWarning } from './asteroidBelt';
import { ASTEROID_BELT } from './asteroidBelt';
import { BELT_CRAWLER } from './beltCrawler';
import { validExploration } from './exploration';
import { validCivicModules } from './furnaces';
import { isShipBoostState } from './shipBoost';
import { SPIDER } from './terrainSpider';
import { WORLD } from './world';

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
const haulerUtility = enumeration<HaulerUtilityId>({
  resource_tap: true,
  boost_coupling: true,
  tow_cable: true,
});
// `build_furnace` is a retired equip token. Older clients may still send it.
const surveyorUtility: Rule = (value) =>
  value === 'mineral_scan' || value === 'survey_probe' || value === 'build_furnace';
const lootKind = enumeration<LootKind>({
  shard: true,
  wreckage: true,
  laserCore: true,
  tap: true,
  silk: true,
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
  silk: optional((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0),
  id: string,
  name: string,
  type: choice('player'),
  position,
  velocity: position,
  angle: number,
  exploding: boolean,
  thrusting: boolean,
  boost: optional(isShipBoostState),
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
  haulerUtility: optional(haulerUtility),
  surveyorUtility: optional(surveyorUtility),
  deathCause: optional(string),
  playerMotion: optional(motion),
  laserUpgrade: optional(upgrade),
});
const armedBoost = shape<Extract<AsteroidBoost, { phase: 'armed' }>>({
  phase: choice('armed'),
  ownerId: string,
  angle: number,
  couplings: optional(array(string)),
});
const burningBoost = shape<Extract<AsteroidBoost, { phase: 'burning' }>>({
  phase: choice('burning'),
  angle: number,
  ownerId: string,
  couplings: optional(array(string)),
});
const probe = shape<AsteroidProbe>({
  id: string,
  ownerId: string,
  health: number,
  maxHealth: number,
  attachedAt: number,
  expiresAt: number,
  angle: number,
  radialOffset: number,
});
const asteroidShape = shape<AsteroidData>({
  beltCrawlerIds: optional(
    (value) =>
      Array.isArray(value) && value.length <= BELT_CRAWLER.MAX_ACTIVE && value.every(string)
  ),
  beltCrawlerHealth: optional(
    (value) =>
      Array.isArray(value) &&
      value.length <= BELT_CRAWLER.MAX_ACTIVE &&
      value.every(
        (health: unknown) => typeof health === 'number' && Number.isFinite(health) && health >= 0
      )
  ),
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
  boost: optional((value) => value === null || armedBoost(value) || burningBoost(value)),
  probe: optional((value) => value === null || probe(value)),
});
const asteroid: Rule = (value) => {
  if (!asteroidShape(value) || typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('beltCrawlerIds' in value) || value.beltCrawlerIds === undefined) {
    return true;
  }
  return (
    Array.isArray(value.beltCrawlerIds) &&
    'beltCrawlerHealth' in value &&
    Array.isArray(value.beltCrawlerHealth) &&
    value.beltCrawlerIds.length === value.beltCrawlerHealth.length &&
    new Set(value.beltCrawlerIds).size === value.beltCrawlerIds.length
  );
};
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
  state: enumeration<SatellitePickupState>({
    loose: true,
    stored: true,
    orbiting: true,
    broken: true,
  }),
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
  kind: choice('furnace', 'foundation', 'laserCore', 'wreckage', 'satellite'),
  position,
  name: string,
});
const SECTOR_IDENTITY_PATTERN = /^-?\d+,-?\d+$/u;
const sectorIdentity: Rule = (value) =>
  typeof value === 'string' && SECTOR_IDENTITY_PATTERN.test(value);
const spider = shape<TerrainSpider>({
  health: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  maxHealth: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  id: string,
  position,
  angle: number,
  phase: choice('scuttling', 'hunting'),
  shudderFrames: optional(number),
  crawler: optional(
    shape<NonNullable<TerrainSpider['crawler']>>({
      hostId: string,
      anchor: position,
      phase: choice('crawling', 'winding', 'lunging', 'recovering', 'escaping'),
      progress: (value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    })
  ),
  probe: optional((value) => value === null || probe(value)),
  targetId: (value) => value === null || string(value),
});
function uniqueRows(rule: Rule, maximum: number): Rule {
  return (value) => {
    if (!Array.isArray(value) || value.length > maximum) {
      return false;
    }
    const ids = new Set<string>();
    return value.every((row: unknown) => {
      if (
        !rule(row) ||
        row === null ||
        typeof row !== 'object' ||
        !('id' in row) ||
        typeof row.id !== 'string' ||
        row.id.length === 0 ||
        ids.has(row.id)
      ) {
        return false;
      }
      ids.add(row.id);
      return true;
    });
  };
}
const nest = shape<SpiderFieldState['nests'][number]>({
  id: sectorIdentity,
  resourceId: (value) => typeof value === 'string' && value.length > 0,
  position,
});
const consumedSpider = shape<NonNullable<SpiderFieldState['consumed']>[number]>({
  id: string,
  position,
  furnaceId: string,
  frame: number,
});
const spiderField = shape<SpiderFieldState>({
  consumed: optional(uniqueRows(consumedSpider, SPIDER.MAX_ACTIVE)),
  spiders: uniqueRows(spider, SPIDER.MAX_ACTIVE + BELT_CRAWLER.MAX_ACTIVE),
  nests: uniqueRows(nest, (2 * Math.ceil(WORLD.radius / SPIDER.NEST_SPACING)) ** 2),
});
const worldRules = {
  civicModules: optional(validCivicModules),
  spiderField: optional(spiderField),
  beltRecovery: optional(
    (value) =>
      Array.isArray(value) &&
      value.length <= ASTEROID_BELT.columns * ASTEROID_BELT.rows &&
      value.every(
        shape<BeltRecoveryWarning>({
          slot: counter,
          position,
          size: number,
          recoverAt: number,
        })
      )
  ),
  exploration: validExploration,
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
