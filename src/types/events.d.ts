import type {
  AsteroidDestroyEvent,
  AsteroidTaggedEvent,
  Position,
  SatellitePickupCollected,
  ShockwaveEvent,
} from '../../shared-types';
import type { PlayerIdentityChangedDetail } from '../network/services/playerIdentityEvents';

declare global {
  interface WindowEventMap {
    gameStart: CustomEvent<undefined>;
    playViewOn: CustomEvent<undefined>;
    playViewOff: CustomEvent<undefined>;
    playerIdentityChanged: CustomEvent<PlayerIdentityChangedDetail>;
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
