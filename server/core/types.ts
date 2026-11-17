import type { WebSocket } from 'ws';
import type { ExplorationMap } from '../../shared/exploration';
import type { FurnaceField } from '../../shared/furnaceField';
import type { AsteroidData, CrewAction, Position, ShipKitId } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { MapAssets } from '../world/MapAssets';
import type { RegionalAsteroidField } from '../world/RegionalAsteroidField';
import type { PersistentPilot } from '../world/WorldStore';
import type { LoadedWorld } from '../world/worldPersistence';
import type { AsteroidHitFeedback } from './AsteroidHitFeedback';
import type { AsteroidLifecycle } from './AsteroidLifecycle';
import type { AsteroidHitOutcome, AsteroidManager } from './AsteroidManager';
import type { AsteroidMining } from './AsteroidMining';
import type { BeltCrawlerManager } from './BeltCrawlerManager';
import type { ChargedWeaponManager } from './ChargedWeaponManager';
import type { CollisionAuthority } from './CollisionAuthority';
import type { ContactCombat } from './ContactCombat';
import type { CooperativeSupplyRestoration } from './CooperativeSupplyRestoration';
import type { CrewRescueManager } from './CrewRescueManager';
import type { EntityManager, GameEntity } from './EntityManager';
import type { FurnaceDeliveryManager } from './FurnaceDeliveryManager';
import type { GlowtoyManager } from './GlowtoyManager';
import type { HiveEncounters } from './HiveEncounters';
import type { ServerLaser } from './LaserCombat';
import type { LootManager } from './LootManager';
import type { PilotLedger } from './PilotLedger';
import type { PlayerMotionService } from './PlayerMotionService';
import type { RNGService } from './RNGService';
import type { SatellitePickupManager } from './SatellitePickupManager';
import type { SettlementLedger } from './SettlementLedger';
import type { ShipAbilityManager } from './ShipAbilityManager';
import type { ShipDamage } from './ShipDamage';
import type { SpiderField } from './SpiderField';
import type { SpiderPopulationBudget } from './SpiderPopulationBudget';
import type { SurveyProbeManager } from './SurveyProbeManager';
import type { TerrainSpiderManager } from './TerrainSpiderManager';

export type RescueAction = Exclude<CrewAction, { kind: 'withdraw-supply' }>;

export interface CombatBroadcast {
  targetId: string;
  attackerId: string;
  damage: number;
  remainingHealth: number;

  isDestroyed: boolean;
  targetType: 'player';
  destroyedAsteroidId?: string;
  newAsteroids?: AsteroidData[];
  origin?: { x: number; y: number };
}

export type CombatSink = (result: CombatBroadcast) => void;

export type ContactCombatInputs = {
  readonly actors: Pick<EntityManager, 'getEntity' | 'getAllEntities'>;
  readonly motion: Pick<PlayerMotionService, 'releaseContourLock' | 'applyExternalImpulse'>;
  readonly rocks: Pick<AsteroidManager, 'spatialIndex' | 'getAsteroid'>;
  readonly mining: Pick<AsteroidMining, 'hit' | 'apply'>;
  readonly damage: Pick<ShipDamage, 'apply'>;
  readonly pickups: Pick<SatellitePickupManager, 'getAllPickups' | 'damage'>;
  readonly collisions: Pick<
    CollisionAuthority,
    'collectAsteroidPickupHits' | 'collectShipAsteroidHits' | 'collectTowedAsteroidHits'
  >;
  readonly spiders: Pick<SpiderField, 'drainAttacks' | 'isAttackActive'>;
  readonly paused: () => boolean;
  readonly serverNow: () => number;
  readonly asteroidHits: Pick<AsteroidHitFeedback, 'emit'>;
};

export type ShipDamageOutcome =
  | { applied: false; isDestroyed: false; entity?: never }
  | { applied: true; isDestroyed: boolean; entity: GameEntity };

export type ShipDamageInputs = {
  readonly actors: Pick<EntityManager, 'getEntity' | 'damageEntity'>;
  readonly motion: Pick<PlayerMotionService, 'releaseContourLock'>;
  readonly rescue: Pick<CrewRescueManager, 'cancel' | 'down'>;
  readonly campaign: Pick<CooperativeCampaign, 'activated'>;
  readonly ledger: Pick<PilotLedger, 'capture'>;
  readonly loot: Pick<LootManager, 'spawnPoints'>;
  readonly serverNow: () => number;
  readonly currentFrame: () => number;
  readonly terminalDeath: (actor: GameEntity, cause: string) => void;
};

export type CrewRescueInputs = {
  readonly actors: Pick<EntityManager, 'getEntity' | 'getAllEntities'>;
  readonly campaign: Pick<CooperativeCampaign, 'activated' | 'get' | 'set' | 'removeDowned'>;
  readonly motion: Pick<PlayerMotionService, 'invalidateLife'>;
  readonly now: () => number;
  readonly cancelCharge: (actor: GameEntity) => void;
  readonly cancelBoost: (id: string, targetId: GameEntity['harpoonTargetId']) => boolean;
  readonly capturePilot: (id: string) => void;
  readonly terminalDeath: (actor: GameEntity, cause: string) => void;
};

export type PilotLedgerInputs = {
  readonly saved: LoadedWorld['pilots'];
  readonly actors: Pick<EntityManager, 'getEntity'>;
  readonly now: () => number;
  readonly settlementLedger: Pick<SettlementLedger, 'addPoints'>;
};

export type PilotRegistration = {
  readonly actor: GameEntity;
  readonly tokenHash: PersistentPilot['tokenHash'];
  readonly clientReleaseId: string | undefined;
};

export type PilotSessionInputs = {
  readonly actors: Pick<
    EntityManager,
    'getEntity' | 'getEntityBySocket' | 'getAllEntities' | 'scheduleShipRespawn'
  >;
  readonly motion: Pick<PlayerMotionService, 'register' | 'resume' | 'invalidateLife'>;
  readonly ledger: Pick<
    PilotLedger,
    'findByTokenHash' | 'saved' | 'rememberClientRelease' | 'recordRegistration' | 'capture'
  >;
  readonly campaign: Pick<CooperativeCampaign, 'get'>;
  readonly rescue: Pick<CrewRescueManager, 'finishIfExpired' | 'restoreDowned'>;
  readonly now: () => number;
  readonly localPlayground: boolean;
  readonly addActor: (input: {
    readonly id: GameEntity['id'];
    readonly name: GameEntity['name'];
    readonly socket: WebSocket;
    readonly position: Position | undefined;
    readonly kitId: ShipKitId | undefined;
  }) => ReturnType<EntityManager['addPlayer']>;
  readonly removeActor: EntityManager['removeEntity'];
  readonly seedInteractions: () => void;
  readonly cancelCharge: (actor: GameEntity) => void;
};

export type PilotSessionRegistration = {
  readonly actor: GameEntity;
  readonly socket: WebSocket;
  readonly clientReleaseId?: string | undefined;
};

export type PilotSessionResume = {
  readonly token: string;
  readonly socket: WebSocket;
  readonly requestedKit?: ShipKitId | undefined;
  readonly requestedName?: string | undefined;
  readonly clientReleaseId?: string | undefined;
};

export interface AppliedAsteroidHit {
  applied: boolean;
  outcome: AsteroidHitOutcome['outcome'];
  asteroidId: string;
  playerId: string;
  points: number;
  newAsteroids: AsteroidData[];
  origin?: Position;
}

export type AsteroidMiningInputs = {
  readonly actors: Pick<EntityManager, 'getEntity'>;
  readonly rocks: Pick<
    AsteroidManager,
    'getAsteroid' | 'registerLaserHit' | 'destroyFromCollision'
  >;
  readonly deliveries: Pick<FurnaceDeliveryManager, 'releaseTowsAttachedTo'>;
  readonly loot: Pick<LootManager, 'spawnTap' | 'spawnPoints' | 'spawnShard' | 'spawnEquipment'>;
  readonly rng: Pick<RNGService, 'random'>;
  readonly currentFrame: () => number;
};

export type AsteroidFieldInputs = {
  readonly actors: Pick<EntityManager, 'getHumanPlayers'>;
  readonly rocks: AsteroidManager;
  readonly regional: Pick<RegionalAsteroidField, 'update'>;
  readonly probes: Pick<SurveyProbeManager, 'observerPositions'>;
  readonly isPaused: () => boolean;
  readonly now: () => number;
};

export type AsteroidLifecycleInputs = {
  readonly rocks: Pick<
    AsteroidManager,
    'addAsteroid' | 'updateAsteroid' | 'removeAsteroid' | 'spatialIndex'
  >;
  readonly probes: Pick<SurveyProbeManager, 'registerAsteroid' | 'unregister'>;
  readonly crawlers: Pick<BeltCrawlerManager, 'escapeDestroyedHost'>;
  readonly currentFrame: () => number;
};

export type FurnaceDeliveryInputs = {
  readonly actors: Pick<EntityManager, 'getAllEntities' | 'getEntity'>;
  readonly rocks: Pick<AsteroidManager, 'getAsteroid' | 'boostedAsteroids'>;
  readonly furnaces: Pick<FurnaceField, 'intakeAt'>;
  readonly hives: Pick<HiveEncounters, 'ruinsNear'>;
  readonly supply: Pick<CooperativeSupplyRestoration, 'permitsDelivery' | 'recordDelivery'>;
  readonly lifecycle: Pick<AsteroidLifecycle, 'remove'>;
  readonly settlement: Pick<SettlementLedger, 'addOre'>;
  readonly awardPilotPoints: PilotLedger['awardPoints'];
  readonly savedPilotName: PilotLedger['savedName'];
};

export type WorldDiscoveryInputs = {
  readonly exploration: Pick<ExplorationMap, 'reveal'>;
  readonly loot: Pick<LootManager, 'queryExplorationCell'>;
  readonly assets: Pick<MapAssets, 'discovered'>;
};

export type ToolFlightInputs = {
  readonly actors: Pick<EntityManager, 'getAllEntities'>;
  readonly rocks: Pick<AsteroidManager, 'spatialIndex' | 'getAsteroid'>;
  readonly spiders: Pick<TerrainSpiderManager, 'getBodies'>;
  readonly hives: Pick<HiveEncounters, 'bodiesNear'>;
  readonly probes: Pick<SurveyProbeManager, 'advanceFlight' | 'pulseNow'>;
  readonly abilities: Pick<ShipAbilityManager, 'survey'>;
  readonly now: () => number;
};

export type SurveyProbeFrameInputs = {
  readonly rocks: Pick<AsteroidManager, 'getAsteroid' | 'spatialIndex'>;
  readonly spiders: Pick<TerrainSpiderManager, 'getBody'>;
  readonly abilities: Pick<ShipAbilityManager, 'survey'>;
};

export type SpiderPopulationInputs = {
  readonly campaign: Pick<CooperativeCampaign, 'activated'>;
  readonly spiders: Pick<TerrainSpiderManager, 'ordinaryCount' | 'setPopulationLimit'>;
  readonly crawlers: Pick<BeltCrawlerManager, 'population' | 'setPopulationLimit'>;
};

export type WorldHazardInputs = {
  readonly campaign: Pick<CooperativeCampaign, 'activated'>;
  readonly population: Pick<SpiderPopulationBudget, 'refresh'>;
  readonly spiders: Pick<TerrainSpiderManager, 'getBody' | 'spawnSpider' | 'removeSpider'>;
  readonly actors: Pick<EntityManager, 'getAllEntities'>;
  readonly hit: (id: GameEntity['id']) => void;
};

export type HiveEncounterInputs = {
  readonly campaign: Pick<CooperativeCampaign, 'activated' | 'all' | 'get' | 'set'>;
  readonly population: Pick<SpiderPopulationBudget, 'refresh'>;
  readonly spiders: Pick<TerrainSpiderManager, 'getBody' | 'spawnSpider' | 'removeSpider'>;
  readonly actors: Pick<EntityManager, 'getAllEntities'>;
};

export type SpiderFieldInputs = {
  readonly actors: Pick<EntityManager, 'getAllEntities' | 'getEntity'>;
  readonly terrain: Pick<
    TerrainSpiderManager,
    'advance' | 'getBodies' | 'getBody' | 'isAttackActive'
  >;
  readonly crawlers: Pick<BeltCrawlerManager, 'advance' | 'isAttackActive'>;
  readonly population: Pick<SpiderPopulationBudget, 'refresh'>;
  readonly rocks: Pick<AsteroidManager, 'spatialIndex' | 'crawlerHostAsteroids' | 'getAsteroid'>;
  readonly regional: Pick<RegionalAsteroidField, 'dormantAsteroid'>;
  readonly loot: Pick<LootManager, 'spawnNestCache' | 'getNestResource' | 'getNestResourcesNear'>;
  readonly satellites: Pick<
    SatellitePickupManager,
    'spawnNestPickup' | 'getPickup' | 'getNestResources'
  >;
  readonly glowtoys: Pick<GlowtoyManager, 'lightSources'>;
};

export type LaserCombatInputs = {
  readonly actors: Pick<EntityManager, 'getEntity' | 'getAllEntities'>;
  readonly charged: Pick<ChargedWeaponManager<ServerLaser>, 'isCharging'>;
  readonly motion: Pick<PlayerMotionService, 'legalSpeed'>;
  readonly rocks: Pick<AsteroidManager, 'spatialIndex' | 'getAsteroid' | 'recordMiningHit'>;
  readonly mining: Pick<AsteroidMining, 'damageFor' | 'hit' | 'apply'>;
  readonly probes: Pick<SurveyProbeManager, 'targetsIn' | 'damage'>;
  readonly terrain: Pick<
    TerrainSpiderManager,
    'getBodies' | 'findLaserHit' | 'getBody' | 'resolveLaserHit'
  >;
  readonly crawlers: Pick<BeltCrawlerManager, 'findLaserHit' | 'getBody' | 'resolveLaserHit'>;
  readonly hives: Pick<HiveEncounters, 'targetsNear' | 'hit'>;
  readonly pickups: Pick<SatellitePickupManager, 'getAllPickups' | 'damage'>;
  readonly loot: Pick<LootManager, 'queryCircle'>;
  readonly combat: Pick<ContactCombat, 'directedHit' | 'emit'>;
  readonly explodeLoot: (owner: string, id: string) => { success: boolean; origin?: Position };
  readonly now: () => number;
  readonly frame: () => number;
};

export type CivicTransactionsInputs = {
  readonly actors: Pick<EntityManager, 'getEntity'>;
  readonly ledger: Pick<PilotLedger, 'capture'>;
  readonly settlement: Pick<SettlementLedger, 'current'>;
  readonly furnaces: Pick<FurnaceField, 'isLit' | 'displayName' | 'light'>;
  readonly paused: () => boolean;
};
