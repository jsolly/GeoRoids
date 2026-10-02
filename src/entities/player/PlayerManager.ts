import type { ShipKitId } from '../../../shared-types';
import { logger } from '../../utils/Logger';
import { entityFactory } from '../EntityFactory';
import type { ShipCombatNetwork } from '../ship/shipCombatNetwork';
import type { Player } from './Player';
import type { PlayerNetworkPort } from './playerNetworkPort';

class PlayerManager {
  private static instance: PlayerManager;
  private localPlayer: Player | null = null;

  constructor(
    private readonly networkPort: PlayerNetworkPort,
    private readonly combatNetwork: ShipCombatNetwork
  ) {}

  public static getInstance(capabilities?: {
    networkPort: PlayerNetworkPort;
    combatNetwork: ShipCombatNetwork;
  }): PlayerManager {
    if (!PlayerManager.instance) {
      if (!capabilities) {
        throw new Error('PlayerManager must be composed with network capabilities before use');
      }
      PlayerManager.instance = new PlayerManager(
        capabilities.networkPort,
        capabilities.combatNetwork
      );
    } else if (
      capabilities &&
      (capabilities.networkPort !== PlayerManager.instance.networkPort ||
        capabilities.combatNetwork !== PlayerManager.instance.combatNetwork)
    ) {
      throw new Error('PlayerManager is already composed with different network capabilities');
    }
    return PlayerManager.instance;
  }

  public getNonLocalPlayers(): Player[] {
    const allPlayers = this.networkPort.getAllPlayers();
    return allPlayers.filter((p) => p.type !== 'local');
  }

  public createLocalPlayer(kitId?: ShipKitId): Player {
    const player = entityFactory.createLocalPlayer('Player', undefined, kitId, this.combatNetwork);
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
    this.networkPort.setLocalPlayerName(name);
  }

  public updateNetworkState(): void {
    if (this.localPlayer) {
      this.networkPort.updatePlayerState(this.localPlayer.getStateForNetwork());
    }
  }
}

export { PlayerManager };
