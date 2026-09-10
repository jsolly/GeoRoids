export interface ServerMessage {
  type:
    | 'playerJoined'
    | 'playerLeft'
    | 'playerUpdate'
    | 'playerShoot'
    | 'playerDamaged'
    | 'playerKilled'
    | 'scoreUpdate'
    | 'gameState'
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
    | 'botCreated'
    | 'botUpdate'
    | 'botDestroyed'
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
    | 'asteroidDamage'
    | 'empDestroy'
    | 'laserDamage'
    | 'playerKilled'
    | 'initAsteroids'
    | 'shield'
    | 'asteroidDestroyed'
    | 'clientLog'
    | 'useAbility'
    | 'asteroidTool'
    | 'asteroidInput'
    | 'lootExplode'
    | 'satelliteDamage'
    | 'satellitePickupCollected';
  id?: string; // Optional ID field for messages that need it
  data: unknown;
  timestamp: number;
}
