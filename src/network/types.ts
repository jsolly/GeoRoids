export interface ClientMessage {
  type:
    | 'join'
    | 'snapshotResync'
    | 'leave'
    | 'update'
    | 'shoot'
    | 'collisionDamage'
    | 'initAsteroids'
    | 'clientLog'
    | 'useAbility'
    | 'setHaulerUtility';
  id?: string; // Optional ID field for messages that need it
  data: unknown;
  timestamp: number;
}
