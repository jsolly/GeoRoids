import type {
  AsteroidDestroyEvent,
  AsteroidTaggedEvent,
  Position,
  SatellitePickupCollected,
  ShockwaveEvent,
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
    }>;
    serverAsteroidTagged: CustomEvent<AsteroidTaggedEvent>;
    serverAsteroidDestroyed: CustomEvent<AsteroidDestroyEvent>;
    serverShockwave: CustomEvent<ShockwaveEvent>;
    satellitePickupCollected: CustomEvent<SatellitePickupCollected>;
  }
}
