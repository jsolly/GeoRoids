import type { CrewAction } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { EntityManager, GameEntity } from './EntityManager';
import type { PlayerMotionService } from './PlayerMotionService';

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
