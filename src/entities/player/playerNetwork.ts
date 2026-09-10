import { GameController } from '../../core/gameController';
import type { Player } from './Player';
import { PlayerManager } from './PlayerManager';

export class PlayerNetwork {
  private static instance: PlayerNetwork;
  private gameController: GameController;
  private playerManager: PlayerManager;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private readonly UPDATE_FREQUENCY = 60; // 60 FPS

  private constructor() {
    this.playerManager = PlayerManager.getInstance();
    // Eagerly initialize gameController to prevent race conditions
    this.gameController = GameController.getInstance();
  }

  public static getInstance(): PlayerNetwork {
    if (!PlayerNetwork.instance) {
      PlayerNetwork.instance = new PlayerNetwork();
    }
    return PlayerNetwork.instance;
  }

  public startNetworkUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(() => {
      this.updatePlayerState();
    }, 1000 / this.UPDATE_FREQUENCY);
  }

  public stopNetworkUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  public updatePlayerState(): void {
    // Update local player state for network (network-only)
    this.gameController.updateNetworkPlayerState();

    // Bot data updates are handled by the network manager's bot sync manager
  }

  public getOtherPlayers(): Player[] {
    // Return all non-local players via unified manager
    return this.playerManager.getNonLocalPlayers();
  }
}
