import type { ShipKitId } from '../../../shared-types';
import { NetworkManager } from '../../network/networkManager';
import { logger } from '../../utils/Logger';
import { entityFactory } from '../EntityFactory';
import type { Player } from './Player';

class PlayerManager {
  private static instance: PlayerManager;
  private networkManager: NetworkManager;

  private constructor() {
    this.networkManager = NetworkManager.getInstance();
  }

  public static getInstance(): PlayerManager {
    if (!PlayerManager.instance) {
      PlayerManager.instance = new PlayerManager();
    }
    return PlayerManager.instance;
  }

  public getNonLocalPlayers(): Player[] {
    // Return all players except the local player (includes bots and remote players)
    const allPlayers = this.networkManager.getAllPlayers();
    return allPlayers.filter((p) => p.type !== 'local');
  }

  // Local player management
  private localPlayer: Player | null = null;

  public createLocalPlayer(kitId?: ShipKitId): Player {
    // Use EntityFactory to ensure proper positioning based on DEBUG settings
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
    this.networkManager.setLocalPlayerName(name);
  }

  public updateNetworkState(): void {
    if (this.localPlayer) {
      this.networkManager.updatePlayerState(this.localPlayer.getStateForNetwork());
    }
  }
}

export { PlayerManager };
