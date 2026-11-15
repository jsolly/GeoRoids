import type { WebSocket } from 'ws';
import type { ExplorationMap } from '../../shared/exploration';
import type { FurnaceField } from '../../shared/furnaceField';
import type { CrewAction, Position, ShipKitId } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { MapAssets } from '../world/MapAssets';
import type { PersistentPilot } from '../world/WorldStore';
import type { LoadedWorld } from '../world/worldPersistence';
import type { AsteroidLifecycle } from './AsteroidLifecycle';
import type { AsteroidManager } from './AsteroidManager';
import type { BeltCrawlerManager } from './BeltCrawlerManager';
import type { CooperativeSupplyRestoration } from './CooperativeSupplyRestoration';
import type { CrewRescueManager } from './CrewRescueManager';
import type { EntityManager, GameEntity } from './EntityManager';
import type { HiveEncounters } from './HiveEncounters';
import type { LootManager } from './LootManager';
import type { PilotLedger } from './PilotLedger';
import type { PlayerMotionService } from './PlayerMotionService';
import type { SettlementLedger } from './SettlementLedger';
import type { ShipAbilityManager } from './ShipAbilityManager';
import type { SpiderPopulationBudget } from './SpiderPopulationBudget';
import type { SurveyProbeManager } from './SurveyProbeManager';
import type { TerrainSpiderManager } from './TerrainSpiderManager';

export type RescueAction = Exclude<CrewAction, { kind: 'withdraw-supply' }>;

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
