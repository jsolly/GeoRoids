import type {
  AsteroidBoost,
  AsteroidData,
  AsteroidMaterial,
  AsteroidPhenomenon,
  AsteroidProbe,
  FurnaceTransit,
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
  SpiderFieldState,
  TerrainSpider,
  UtilityFlight,
} from '../shared-types';
import type { BeltRecoveryWarning } from './asteroidBelt';
import { ASTEROID_BELT } from './asteroidBelt';
import { BELT_CRAWLER } from './beltCrawler';
import { CONTOUR_BRIDGE } from './contourBridge';
import { isContourLockState } from './contourLock';
import { COOPERATIVE } from './cooperativeRules';
import { validCooperativeRecord } from './cooperativeWorld';
import { validSettlement } from './economy';
import { validEquipment } from './equipment';
import { validExploration } from './exploration';
import { frontierSite } from './frontier';
import { civicLot, TOWN_HEARTH, validCivicModules } from './furnaces';
import { FURNACE_TRAVEL } from './furnaceTravel';
import { ROLY_POLY } from './rolyPoly';
import { isHaulerUtilityId, isScoutUtilityId } from './shipUtilities';
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
  <T extends string>(values: Record<T, true>) =>
  (value: unknown): value is T =>
    typeof value === 'string' && Object.hasOwn(values, value);
const kit = enumeration<ShipKitId>({
  scout: true,
  hauler: true,
});
export const isLootKind = enumeration<LootKind>({
  shard: true,
  tap: true,
  silk: true,
  resource_tap: true,
  boost_coupling: true,
  survey_probe: true,
  points: true,
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
const outboundFlight = shape<Extract<UtilityFlight, { phase: 'outbound' }>>({
  kind: choice('tow', 'probe'),
  phase: choice('outbound'),
  position,
  velocity: position,
  remainingDistance: (candidate) =>
    number(candidate) && typeof candidate === 'number' && candidate >= 0,
});
const reelingFlight = shape<Extract<UtilityFlight, { phase: 'reeling' }>>({
  kind: choice('tow'),
  phase: choice('reeling'),
  position,
  framesLeft: counter,
});
const disintegratingFlight = shape<Extract<UtilityFlight, { phase: 'disintegrating' }>>({
  kind: choice('probe'),
  phase: choice('disintegrating'),
  position,
  framesLeft: counter,
});
const utilityFlight: Rule = (value) =>
  outboundFlight(value) || reelingFlight(value) || disintegratingFlight(value);
const energy: Rule = (value) => number(value) && (value as number) >= 0 && (value as number) <= 8;
const material = enumeration<AsteroidMaterial>({
  ice: true,
  metal: true,
  rubble: true,
  crystal: true,
});
const motion = shape<PlayerMotionState>({
  epoch: counter,
  mode: choice('free', 'handoff'),
  ack: counter,
  anchor: optional(position),
});
const reflective = shape<Extract<AsteroidPhenomenon, { kind: 'reflective' }>>({
  kind: choice('reflective'),
  clusterId: string,
  energy,
  maxEnergy: energy,
});
const hearthId: Rule = (value) =>
  typeof value === 'string' &&
  (value === TOWN_HEARTH.id || civicLot(value) !== undefined || frontierSite(value) !== undefined);
const transit = shape<FurnaceTransit>({
  sourceId: hearthId,
  destinationId: hearthId,
  startedAt: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  durationMs: (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= FURNACE_TRAVEL.MIN_DURATION_MS &&
    value <= FURNACE_TRAVEL.MAX_DURATION_MS,
});
const entity = shape<ServerEntityData>({
  botRole: optional(choice('worker', 'raider')),
  downedUntil: optional((value) => value === null || counter(value)),
  rescue: optional(
    (value) => value === null || shape({ targetId: string, completesAt: counter })(value)
  ),
  crewSignal: optional(
    (value) =>
      value === null || shape({ kind: choice('help', 'nest'), position, expiresAt: counter })(value)
  ),
  furnaceTransit: optional(
    (value) =>
      value === null ||
      (transit(value) &&
        typeof value === 'object' &&
        value !== null &&
        'sourceId' in value &&
        'destinationId' in value &&
        value.sourceId !== value.destinationId)
  ),
  equipment: optional(validEquipment),
  silk: optional((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0),
  id: string,
  name: string,
  type: choice('player'),
  position,
  velocity: position,
  angle: number,
  exploding: boolean,
  thrusting: boolean,
  contourLock: optional(isContourLockState),
  color: string,
  cargo: counter,
  bankedCargo: optional(counter),
  weaponChargeFrames: optional(counter),
  navigationAssistFrames: optional(counter),
  contourDraftFrames: optional(counter),
  purchases: array(string),
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
  utilityFlight: optional((value) => value === null || utilityFlight(value)),
  haulerUtility: optional(isHaulerUtilityId),
  scoutUtility: optional(isScoutUtilityId),
  playerMotion: optional(motion),
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
  supply: optional(
    shape({
      sourceId: hearthId,
      value: (value) =>
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= COOPERATIVE.shipmentValue,
    })
  ),
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
  material: optional(material),
  ore: optional((value) => value === null || material(value)),
  surveyedBy: optional(array(string)),
  miningContributors: optional(array(string)),
  phenomenon: optional(reflective),
  contourRider: optional((value) => value === null || isContourLockState(value)),
  glowtoy: optional(
    shape({
      charge: (value) => number(value) && (value as number) >= 0 && (value as number) <= 1,
      cachePosition: position,
      cacheRevealed: boolean,
    })
  ),
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
  salvage: optional(material),
  points: optional(counter),
  id: string,
  position,
  mass: number,
  radius: number,
  kind: isLootKind,
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
const mapAsset = shape<MapAsset>({
  id: string,
  kind: choice('furnace', 'foundation', 'wreckage', 'satellite', 'ship-remains', 'nest-remains'),
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
  cleared: boolean,
  id: sectorIdentity,
  resourceId: (value) => typeof value === 'string' && value.length > 0,
  position,
});
const spiderField = shape<SpiderFieldState>({
  spiders: uniqueRows(spider, SPIDER.MAX_ACTIVE + BELT_CRAWLER.MAX_ACTIVE),
  nests: uniqueRows(nest, (2 * Math.ceil(WORLD.radius / SPIDER.NEST_SPACING)) ** 2),
});
const worldRules = {
  cooperativeActive: optional(boolean),
  campaign: optional(
    shape({
      projectValue: (value) =>
        counter(value) && typeof value === 'number' && value <= COOPERATIVE.scannerValue,
      supplies: (value) =>
        Array.isArray(value) &&
        value.length <= 512 &&
        value.every(shape({ id: hearthId, value: counter })),
      hives: (value) =>
        Array.isArray(value) &&
        value.length <= 512 &&
        value.every(
          (row: unknown) =>
            validCooperativeRecord(row) &&
            row.kind === 'hive' &&
            'shieldOpen' in row &&
            typeof row.shieldOpen === 'boolean'
        ),
      commissioned: (value) =>
        Array.isArray(value) &&
        value.length <= 512 &&
        value.every((id: unknown) => typeof id === 'string' && frontierSite(id)),
      cleared: (value) =>
        Array.isArray(value) &&
        value.length <= 512 &&
        value.every((id: unknown) => typeof id === 'string' && frontierSite(id)),
      hazard: shape({
        phase: choice('quiet', 'warning', 'active'),
        kind: choice('swarm', 'meteors'),
        startsAt: counter,
        endsAt: counter,
      }),
      meteors: (value) =>
        Array.isArray(value) && value.length <= 12 && value.every(shape({ id: string, position })),
    })
  ),
  serverTime: number,
  settlement: validSettlement,
  civicModules: validCivicModules,
  spiderField,
  beltRecovery: (value) =>
    Array.isArray(value) &&
    value.length <= ASTEROID_BELT.columns * ASTEROID_BELT.rows &&
    value.every(
      shape<BeltRecoveryWarning>({
        slot: counter,
        position,
        size: number,
        recoverAt: number,
      })
    ),
  contourBridges: optional(
    uniqueRows(
      shape({
        id: string,
        ownerId: string,
        from: position,
        to: position,
        source: isContourLockState,
        target: isContourLockState,
        charged: boolean,
        framesLeft: counter,
      }),
      CONTOUR_BRIDGE.maximum
    )
  ),
  rolyPolys: optional(
    uniqueRows(
      shape({
        id: string,
        position,
        velocity: position,
        phase: choice('walking', 'curled', 'rolling'),
      }),
      ROLY_POLY.maximumActive
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
  terrainSeed: number,
} satisfies Shape<ServerGameState>;
const world = shape<ServerGameSnapshot>({
  ...worldRules,
  playerProjectiles: array(playerProjectile),
});
/** Validate one persisted asteroid with the same metadata rules used on the wire. */
export function isAsteroidDto(value: unknown): value is AsteroidData {
  return asteroid(value);
}

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
}
