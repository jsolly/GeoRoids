import type { AsteroidDestroyEvent, Position, SatellitePickupCollected } from '../../shared-types';
import type { PlayerIdentityChangedDetail } from '../network/services/playerIdentityEvents';

declare global {
  interface WindowEventMap {
    gameStart: CustomEvent<undefined>;
    playViewOn: CustomEvent<undefined>;
    playViewOff: CustomEvent<undefined>;
    gameSchematicOpen: CustomEvent<undefined>;
    gameSchematicClose: CustomEvent<undefined>;
    gameMapOpen: CustomEvent<undefined>;
    gameMapClose: CustomEvent<undefined>;
    playerIdentityChanged: CustomEvent<PlayerIdentityChangedDetail>;
    shipExploded: CustomEvent<{
      shipId?: string;
      position?: Position;
      cause?: string;
    }>;
    serverAsteroidDestroyed: CustomEvent<AsteroidDestroyEvent>;
    satellitePickupCollected: CustomEvent<SatellitePickupCollected>;
  }
}
