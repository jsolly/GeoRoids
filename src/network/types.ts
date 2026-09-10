import type { PongMessage } from '../../shared-types';

export type ServerMessage = PongMessage | GameServerMessage;

interface GameServerMessage {
  type:
    | 'playerJoined'
    | 'playerLeft'
    | 'playerDamaged'
    | 'playerKilled'
    | 'scoreUpdate'
    | 'snapshot'
    | 'error'
    | 'joined'
    | 'sessionExpired'
    | 'asteroidCreate'
    | 'asteroidCreateBatch'
    | 'asteroidUpdate'
    | 'asteroidDestroy'
    | 'asteroidTagged'
    | 'shockwave'
    | 'abilityUsed'
    | 'lootExploded'
    | 'satelliteShoot'
    | 'satellitePickupCollected';
  data?: unknown;
  timestamp: number;
}

export interface ClientMessage {
  type:
    | 'join'
    | 'snapshotResync'
    | 'leave'
    | 'update'
    | 'shoot'
    | 'collisionDamage'
    | 'initAsteroids'
    | 'shield'
    | 'clientLog'
    | 'useAbility'
    | 'asteroidTool'
    | 'asteroidInput'
    | 'satellitePickupCollected';
  id?: string; // Optional ID field for messages that need it
  data: unknown;
  timestamp: number;
}
