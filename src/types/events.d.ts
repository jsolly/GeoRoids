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
    serverAsteroidTagged: CustomEvent<AsteroidTaggedEvent>;
    serverAsteroidDestroyed: CustomEvent<AsteroidDestroyEvent>;
    serverShockwave: CustomEvent<ShockwaveEvent>;
    satellitePickupCollected: CustomEvent<SatellitePickupCollected>;
  }
}
