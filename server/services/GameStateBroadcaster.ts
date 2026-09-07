import { WebSocket } from 'ws';
import { GameEngine, type CombatBroadcast } from '../core/GameEngine';
import { logger } from '../../setup/serverLogger';

export class GameStateBroadcaster {
  private gameEngine: GameEngine;
  private broadcastInterval: NodeJS.Timeout | null = null;

  constructor(gameEngine: GameEngine) {
    this.gameEngine = gameEngine;
  }

  public startPeriodicBroadcast(): void {
    if (this.broadcastInterval) {
      return; // Already running
    }

    // Periodic game state broadcast (30 FPS for smooth bot movement)
    this.broadcastInterval = setInterval(() => {
      this.flushExpiredCollabHits();
      if (this.gameEngine.getPlayerCount() > 0) {
        this.broadcastGameState();
        this.broadcastPendingBotShots();
      }
    }, 1000 / 30); // 30 FPS (33.33ms) for smooth bot movement
  }

  private broadcastPendingBotShots(): void {
    for (const shot of this.gameEngine.consumeBotShots()) {
      // Bot ids never match a human socket, so every client receives the shot
      // on the same playerShoot path used by remote humans.
      this.broadcastPlayerShoot(shot.botId, shot.laserStart, shot.laserDirection);
    }
  }

  public stopPeriodicBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  public broadcastGameState(excludeId?: string): void {
    // Covers destruction paths invoked outside the frame loop (for example a
    // client asteroid report) before publishing the authoritative snapshot.
    this.gameEngine.ensureAsteroidField();
    const gameState = this.gameEngine.getGameState();
    const message = {
      type: 'gameState',
      data: gameState,
      timestamp: Date.now(),
    };

    this.broadcastToAll(message, excludeId);
  }

  public broadcastPlayerLeft(playerId: string): void {
    const message = {
      type: 'playerLeft',
      data: {
        id: playerId,
      },
      timestamp: Date.now(),
    } as const;

    this.broadcastToAll(message, playerId);
  }

  public broadcastPlayerJoined(playerId: string, playerName: string, position: { x: number; y: number }): void {
    const message = {
      type: 'playerJoined',
      data: {
        id: playerId,
        name: playerName,
        position,
      },
      timestamp: Date.now(),
    } as const;

    this.broadcastToAll(message, playerId);
  }

  public broadcastPlayerUpdate(playerId: string, updateData: any): void {
    const message = {
      type: 'playerUpdate',
      data: { id: playerId, ...updateData },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message, playerId);
  }

  public broadcastPlayerShoot(playerId: string, laserStart: any, laserDirection: any): void {
    const timestamp = Date.now();
    const message = {
      type: 'playerShoot',
      data: {
        id: playerId,
        laserStart,
        laserDirection,
      },
      timestamp,
    };

    this.broadcastToAll(message, playerId);
  }

  public broadcastCombatResult(result: CombatBroadcast): void {
    if (result.targetType === 'bot') {
      this.broadcastBotUpdate(result.targetId);
    } else {
      this.broadcastPlayerDamaged(
        result.targetId,
        result.attackerId,
        result.damage,
        result.remainingHealth,
        result.isDestroyed,
        result.remainingLives
      );
    }

    if (result.isDestroyed) {
      this.broadcastPlayerKilled(result.targetId, result.targetName, result.attackerId);
      if (result.awardedScore) {
        this.broadcastScoreUpdate(result.awardedScore.playerId, result.awardedScore.score);
      }
    }

    if (result.destroyedAsteroidId) {
      this.broadcastAsteroidDestruction(result.destroyedAsteroidId, {
        collabSplit: result.collabSplit === true,
        origin: result.origin,
      });
      if (result.newAsteroids && result.newAsteroids.length > 0) {
        this.broadcastAsteroidCreation(result.newAsteroids);
      }
      if (result.asteroidScore) {
        this.broadcastScoreUpdate(result.asteroidScore.playerId, result.asteroidScore.score);
      }
    }
  }

  public broadcastPlayerDamaged(
    targetPlayerId: string,
    attackerId: string,
    damage: number,
    remainingHealth: number,
    isDestroyed: boolean,
    remainingLives?: number
  ): void {
    const message = {
      type: 'playerDamaged',
      data: {
        targetPlayerId,
        attackerId,
        damage,
        remainingHealth,
        isDestroyed,
        ...(remainingLives !== undefined ? { remainingLives } : {}),
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastPlayerKilled(targetPlayerId: string, targetPlayerName: string, attackerId: string): void {
    const message = {
      type: 'playerKilled',
      data: {
        targetPlayerId,
        targetPlayerName,
        attackerId,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastScoreUpdate(playerId: string, score: number): void {
    const message = {
      type: 'scoreUpdate',
      data: {
        playerId,
        score,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastAsteroidCreation(asteroids: any[]): void {
    const message = {
      type: 'asteroidCreateBatch',
      data: {
        asteroids: asteroids,
      },
      timestamp: Date.now(),
    };

    logger.debug('Broadcasting asteroid creation batch', {
      asteroidCount: asteroids.length,
    });
    this.broadcastToAll(message);
  }

  public broadcastLootExploded(event: {
    lootId: string;
    position: { x: number; y: number };
    radius: number;
    shooterId: string;
  }): void {
    this.broadcastToAll({
      type: 'lootExploded',
      data: event,
      timestamp: Date.now(),
    });
  }

  public broadcastAsteroidDestruction(
    asteroidId: string,
    extras?: { collabSplit?: boolean; origin?: { x: number; y: number } }
  ): void {
    const message = {
      type: 'asteroidDestroy',
      data: {
        asteroidId,
        collabSplit: extras?.collabSplit === true,
        origin: extras?.origin,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastShockwave(event: { origin: { x: number; y: number }; asteroidId?: string }): void {
    const message = {
      type: 'shockwave',
      data: {
        origin: { x: event.origin.x, y: event.origin.y },
        asteroidId: event.asteroidId,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastAsteroidTagged(event: {
    asteroidId: string;
    shooterId: string;
    expiresAt: number;
  }): void {
    const message = {
      type: 'asteroidTagged',
      data: {
        asteroidId: event.asteroidId,
        shooterId: event.shooterId,
        expiresAt: event.expiresAt,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  private flushExpiredCollabHits(): void {
    this.gameEngine.flushExpiredCollabHits();
    const expired = this.gameEngine.drainResolvedCollabHits();
    for (const item of expired) {
      const player = this.gameEngine.getPlayer(item.playerId);
      if (player) {
        this.broadcastScoreUpdate(item.playerId, player.score);
      }
      this.broadcastAsteroidDestruction(item.destroyed.id, {
        collabSplit: false,
        origin: item.destroyed.position,
      });
    }
  }

  public broadcastAsteroidUpdate(asteroidId: string, updates: any): void {
    const message = {
      type: 'asteroidUpdate',
      data: { asteroidId, updates },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastBotCreation(bots: any[]): void {
    const botSummaries = bots.map(bot => ({
      botId: bot.id,
      botName: bot.name,
      position: bot.position,
    }));

    const message = {
      type: 'botsCreated',
      data: {
        bots: botSummaries,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastBotUpdate(botId: string): void {
    const bot = this.gameEngine.getBot(botId);
    if (bot) {
      const message = {
        type: 'botUpdate',
        data: {
          botId: bot.id,
          playerId: 'server',
          position: bot.position,
          velocity: bot.velocity,
          angle: bot.angle,
          exploding: bot.exploding,
          thrusting: bot.thrusting,
          color: bot.color,
          lives: bot.lives,
          health: bot.health,
          maxHealth: bot.maxHealth,
          fuel: bot.fuel,
          maxFuel: bot.maxFuel,
          mass: bot.mass,
          kitId: bot.kitId,
          factionId: bot.factionId,
          abilityCooldownFrames: bot.abilityCooldownFrames,
          abilityActiveFrames: bot.abilityActiveFrames,
          shieldTimer: bot.shieldTimer,
          harpoonTimer: bot.harpoonTimer,
          harpoonTargetId: bot.harpoonTargetId,
          harpoonLatchPos: bot.harpoonLatchPos,
          shieldActive: bot.shieldActive,
          shieldTime: bot.shieldTime,
          shieldCooldown: bot.shieldCooldown,
          shieldFlashTime: bot.shieldFlashTime,
        },
        timestamp: Date.now(),
      };

      this.broadcastToAll(message);
    }
  }

  public broadcastBotDestroyed(botId: string): void {
    const message = {
      type: 'botDestroyed',
      data: { botId },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastChatMessage(playerId: string, playerName: string, message: string): void {
    const chatMessage = {
      type: 'chat',
      data: {
        id: playerId,
        name: playerName,
        message,
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(chatMessage);
  }

  public sendToWebSocket(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  public sendError(ws: WebSocket, message: string): void {
    this.sendToWebSocket(ws, {
      type: 'error',
      data: message,
      timestamp: Date.now(),
    });
  }

  public broadcastToAll(message: any, excludeId?: string): void {
    let messageStr: string;
    try {
      messageStr = JSON.stringify(message);
    } catch (error) {
      // A circular Timeout on player.ws used to kill the process here and
      // flap every client into the Reconnecting banner (#485 live miss).
      logger.error('Failed to serialize broadcast', {
        type: message?.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const humanPlayers = this.gameEngine.entityManager.getHumanPlayers();

    for (const player of humanPlayers) {
      if (excludeId && player.id === excludeId) {
        continue;
      }

      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        try {
          player.ws.send(messageStr);
        } catch (error) {
          logger.error(`Failed to send message to player ${player.id} (readyState: ${player.ws.readyState})`, error);
          // For unrecoverable errors, close the connection and remove the player
          try {
            player.ws.close();
          } catch (closeError) {
            logger.error(`Failed to close WebSocket for player ${player.id}`, closeError);
          }
          // Remove the player from the game engine
          this.gameEngine.removePlayer(player.id);
          this.broadcastPlayerLeft(player.id);
        }
      }
    }
  }
}
