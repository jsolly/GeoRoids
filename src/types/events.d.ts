import type {
  AsteroidDestroyEvent,
  AsteroidTaggedEvent,
  Position,
  SatellitePickupCollected,
  ShockwaveEvent,
  Velocity,
} from '../../shared-types';

declare global {
  interface WindowEventMap {
    gameStart: CustomEvent<undefined>;
    playerDied: CustomEvent<{
      playerId: string;
      deathCause: string;
      isGameOver: boolean;
    }>;
    shipExploded: CustomEvent<{
      shipId?: string;
      position?: Position;
      cause?: string;
      killerName?: string;
    }>;
    serverAsteroidTagged: CustomEvent<AsteroidTaggedEvent>;
    serverAsteroidDestroyed: CustomEvent<AsteroidDestroyEvent>;
    serverShockwave: CustomEvent<ShockwaveEvent>;
    botShoot: CustomEvent<{
      laserStart: Position;
      laserDirection: Velocity;
    }>;
    satellitePickupCollected: CustomEvent<SatellitePickupCollected>;
  }
}
