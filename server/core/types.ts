import type { WebSocket } from 'ws';
import type { CrewAction, Position, ShipKitId } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { PersistentPilot } from '../world/WorldStore';
import type { LoadedWorld } from '../world/worldPersistence';
import type { CrewRescueManager } from './CrewRescueManager';
import type { EntityManager, GameEntity } from './EntityManager';
import type { PilotLedger } from './PilotLedger';
import type { PlayerMotionService } from './PlayerMotionService';
import type { SettlementLedger } from './SettlementLedger';

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
