import type { ShipKitId } from '../../../shared-types';
import { logger } from '../../utils/Logger';
import { entityFactory } from '../EntityFactory';
import type { Player } from './Player';
import { requirePlayerNetworkPort } from './playerNetworkPort';

class PlayerManager {
  private static instance: PlayerManager;
  private localPlayer: Player | null = null;

  public static getInstance(): PlayerManager {
    if (!PlayerManager.instance) {
      PlayerManager.instance = new PlayerManager();
    }
    return PlayerManager.instance;
  }

  public getNonLocalPlayers(): Player[] {
    const allPlayers = requirePlayerNetworkPort().getAllPlayers();
    return allPlayers.filter((p) => p.type !== 'local');
  }

  public createLocalPlayer(kitId?: ShipKitId): Player {
    const player = entityFactory.createLocalPlayer('Player', undefined, kitId);
    this.localPlayer = player;
    return player;
  }

  public getLocalPlayer(): Player | null {
    return this.localPlayer;
  }

  public getLocalShip() {
    return this.localPlayer?.ship;
  }

  public setPlayerName(name: string): void {
    logger.debug('PLAYER', 'Setting player name', { nameLength: name.length });
    if (this.localPlayer) {
      logger.debug('PLAYER', 'Updating local player identity', { playerId: this.localPlayer.id });
      this.localPlayer.name = name;
    } else {
      logger.warn('PLAYER', 'Cannot set player name - no local player exists');
    }
    requirePlayerNetworkPort().setLocalPlayerName(name);
  }

  public updateNetworkState(): void {
    if (this.localPlayer) {
      requirePlayerNetworkPort().updatePlayerState(this.localPlayer.getStateForNetwork());
    }
  }
}

export { PlayerManager };
