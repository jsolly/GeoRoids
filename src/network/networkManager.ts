import type { PlayerUpdate } from '../../shared-types';
import type { Laser } from '../entities/laser/Laser';
import type { Player } from '../entities/player/Player';
import { logger } from '../utils/Logger';
import { ConnectionManager } from './services/ConnectionManager';

/**
 * Simplified NetworkManager for multiplayer-only game
 */
export class NetworkManager {
  private static instance: NetworkManager;

  private connectionManager: ConnectionManager;

  private constructor() {
    this.connectionManager = ConnectionManager.getInstance();
    this.setupConnectionHandlers();
  }

  static getInstance(): NetworkManager {
    if (!NetworkManager.instance) {
      NetworkManager.instance = new NetworkManager();
    }
    return NetworkManager.instance;
  }

  // Connection management
  async connect(): Promise<void> {
    await this.connectionManager.connect();
  }

  disconnect(options?: { newSession?: boolean }): void {
    this.connectionManager.disconnect(options);
  }

  get isConnected(): boolean {
    return this.connectionManager.isConnected();
  }

  // Player management
  setLocalPlayerName(name: string): void {
    logger.debug('NETWORK', 'Applying local player identity', { nameLength: name.length });
    this.connectionManager.setLocalPlayerName(name);
  }

  getLocalPlayerName(): string {
    return this.connectionManager.getLocalPlayerName();
  }

  getLocalPlayerId(): string {
    return this.connectionManager.getLocalPlayerId();
  }

  getAllPlayers(): Player[] {
    return this.connectionManager.getAllPlayers();
  }

  getRemotePlayers(): Player[] {
    return this.connectionManager.getRemotePlayers();
  }

  getPlayer(playerId: string): Player | undefined {
    return this.connectionManager.getPlayer(playerId);
  }

  // Player state synchronization - just send input to server
  updatePlayerState(playerState: Omit<PlayerUpdate, 'id' | 'name'>): void {
    const fullPlayerState = {
      id: this.getLocalPlayerId() || this.connectionManager.getClientId(),
      name: this.getLocalPlayerName(),
      ...playerState,
    };
    this.connectionManager.sendPlayerState(fullPlayerState);
  }

  sendShootEvent(laser: Laser): void {
    this.connectionManager.sendShootEvent(laser);
  }

  // Initialize asteroid sync - server is authoritative
  initializeAsteroidSync(): void {
    this.connectionManager.initializeAsteroidSync();
  }

  // Send a generic message to the server
  sendMessage(message: Record<string, unknown>): boolean {
    return this.connectionManager.sendMessage(message);
  }

  private setupConnectionHandlers(): void {
    // Listen for connection events
    window.addEventListener('networkConnected', () => {
      logger.info('NETWORK', 'Connected to game server');
    });

    window.addEventListener('networkDisconnected', (event) => {
      const customEvent = event as CustomEvent<{ reason: string }>;
      logger.warn('NETWORK', `Disconnected: ${customEvent.detail.reason}`);
    });

    window.addEventListener('networkReconnected', () => {
      logger.info('NETWORK', 'Reconnected to game server');
    });
  }
}
