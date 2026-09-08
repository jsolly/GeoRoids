import type { WebSocket } from 'ws';
import type { GameEngine } from '../core/GameEngine';
import { GameStateBroadcaster } from '../services/GameStateBroadcaster';
import { MessageHandler } from './MessageHandler';

export class WebSocketCore {
  private gameEngine: GameEngine;
  private messageHandler: MessageHandler;
  private broadcaster: GameStateBroadcaster;

  constructor(gameEngine: GameEngine, requireEnhancedClient = false) {
    this.gameEngine = gameEngine;
    this.broadcaster = new GameStateBroadcaster(gameEngine);
    this.messageHandler = new MessageHandler(gameEngine, this.broadcaster, requireEnhancedClient);
    this.gameEngine.setCombatSink((result) => this.broadcaster.broadcastCombatResult(result));
  }

  public startPeriodicGameStateBroadcast(): void {
    this.broadcaster.startPeriodicBroadcast();
  }

  public stopPeriodicGameStateBroadcast(): void {
    this.broadcaster.stopPeriodicBroadcast();
  }

  public handleClientMessage(message: unknown, ws: WebSocket): void {
    this.messageHandler.handleMessage(message, ws);
  }

  public sendToWebSocket(ws: WebSocket, message: unknown): void {
    this.broadcaster.sendToWebSocket(ws, message);
  }

  public sendError(ws: WebSocket, message: string): void {
    this.broadcaster.sendError(ws, message);
  }

  public broadcastToAll(message: unknown, excludeId?: string): void {
    this.broadcaster.broadcastToAll(message, excludeId);
  }

  public getPlayerCount(): number {
    return this.gameEngine.getPlayerCount();
  }

  public getAllPlayers() {
    return this.gameEngine.getAllPlayers();
  }

  public removePlayer(id: string) {
    const removed = this.gameEngine.removePlayer(id);
    if (removed?.type === 'human') {
      this.broadcaster.broadcastPlayerLeft(id);
    }
    return removed;
  }

  // Convenience methods for external access
  public getGameEngine(): GameEngine {
    return this.gameEngine;
  }

  public getBroadcaster(): GameStateBroadcaster {
    return this.broadcaster;
  }

  public getMessageHandler(): MessageHandler {
    return this.messageHandler;
  }
}
