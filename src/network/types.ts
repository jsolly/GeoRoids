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
    | 'useAbility';
  id?: string; // Optional ID field for messages that need it
  data: unknown;
  timestamp: number;
}
