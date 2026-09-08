import type { Position, Velocity } from '../../shared-types';
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
    logger.debug('NETWORK', `NetworkManager.setLocalPlayerName called with: ${name}`);
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
  updatePlayerState(playerState: {
    position: Position;
    velocity: Velocity;
    r: number;
    angle: number;
    lives?: number;
    score?: number;
    exploding: boolean;
    thrusting?: boolean;
    health?: number;
    maxHealth?: number;
    lasers?: Array<{
      position: Position;
      velocity: Velocity;
      distTraveled: number;
      explodeTime: number;
      hasExploded: boolean;
    }>;
  }): void {
    // Add required fields for PlayerUpdate
    const fullPlayerState = {
      id: this.getLocalPlayerId() || this.connectionManager.getClientId(),
      name: this.getLocalPlayerName(),
      health: playerState.health ?? 100, // Default to 100 if not provided
      maxHealth: playerState.maxHealth ?? 100, // Default to 100 if not provided
      ...playerState,
    };
    this.connectionManager.sendPlayerState(fullPlayerState);
  }

  dispatchAsteroidMotionAction(
    action: 'release' | 'anchor' | 'brake' | 'spin',
    targetId?: string
  ): boolean {
    return this.connectionManager.dispatchAsteroidMotionAction(action, targetId);
  }

  sendShootEvent(laserPosition: Position, laserVelocity: Velocity): void {
    this.connectionManager.sendShootEvent(laserPosition, laserVelocity);
  }

  // Initialize asteroid sync - server is authoritative
  initializeAsteroidSync(): void {
    this.connectionManager.initializeAsteroidSync();
  }

  // Send a generic message to the server
  sendMessage(message: Record<string, unknown>): void {
    this.connectionManager.sendMessage(message);
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
