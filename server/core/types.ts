import type { CrewAction } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { PersistentPilot } from '../world/WorldStore';
import type { LoadedWorld } from '../world/worldPersistence';
import type { EntityManager, GameEntity } from './EntityManager';
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
