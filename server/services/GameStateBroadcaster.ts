import { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import {
  captureSnapshot,
  encodeSnapshot,
  SNAPSHOT_BACKPRESSURE_BYTES,
  SNAPSHOT_KEYFRAME_INTERVAL,
  SNAPSHOT_VERSION,
  type SnapshotBaseline,
} from '../../shared/snapshotProtocol';
import { captureDiagnosticActorState, shouldSampleSnapshot } from '../../shared/stateDiagnostics';
import type { AsteroidData, Position, ServerGameSnapshot, Velocity } from '../../shared-types';
import type { CombatBroadcast, GameEngine } from '../core/GameEngine';
import { SERVER_RELEASE_ID } from '../release';

interface SnapshotRecipient {
  baseline?: SnapshotBaseline;
  sequence: number;
  sinceKeyframe: number;
  pending: boolean;
  needsKeyframe: boolean;
}

interface PlayerUpdateData {
  position?: Position;
  velocity?: Velocity;
  angle?: number;
  thrusting?: boolean;
  rotation?: number;
  angularVelocity?: number;
  a?: number;
}

type AsteroidUpdateData = Partial<AsteroidData>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageType(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  return typeof message['type'] === 'string' ? message['type'] : undefined;
}

export class GameStateBroadcaster {
  private gameEngine: GameEngine;
  private readonly snapshotRecipients = new WeakMap<WebSocket, SnapshotRecipient>();
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
        for (const shot of this.gameEngine.drainSatelliteShots()) {
          this.broadcastSatelliteShoot(shot);
        }
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
    for (const id of this.gameEngine.drainDepartedPlayers()) {
      this.broadcastPlayerLeft(id);
    }
    const gameState = this.gameEngine.getGameState();
    // The deployed snapshot-v1 client validates a closed loot-kind enum.
    // Preserve each core's identity/position/reward for old pilots using its
    // existing mineral pickup visual; never send an undecodable new enum.
    const compatibleLoot = gameState.loot.map((loot) =>
      loot.kind === 'laserCore' ? { ...loot, kind: 'shard' as const } : loot
    );
    const message = {
      type: 'gameState',
      data: gameState,
      timestamp: Date.now(),
    };

    for (const blast of this.gameEngine.drainLootBlasts()) {
      this.broadcastLootExploded(blast);
    }
    for (const bounce of this.gameEngine.drainReflections()) {
      this.broadcastToAll({ type: 'playerShoot', data: bounce, timestamp: Date.now() });
    }
    const players = this.gameEngine.entityManager.getHumanPlayers();
    let canonical: ServerGameSnapshot | undefined;
    let legacy: string | undefined;
    for (const player of players) {
      const ws = player.ws;
      if (!ws || (excludeId && player.id === excludeId)) {
        continue;
      }
      const recipient = this.snapshotRecipients.get(ws);
      if (!recipient) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            legacy ??= JSON.stringify({ ...message, data: { ...gameState, loot: compatibleLoot } });
            ws.send(legacy);
          } catch (error) {
            logger.error('Failed to send legacy game state', error);
            this.closeFailedSnapshotSocket(ws);
          }
        }
        continue;
      }
      if (
        ws.readyState !== WebSocket.OPEN ||
        ws.bufferedAmount > SNAPSHOT_BACKPRESSURE_BYTES ||
        recipient.pending
      ) {
        recipient.needsKeyframe = true;
        continue;
      }
      try {
        canonical ??= captureSnapshot({
          ...gameState,
          playerProjectiles: this.gameEngine.getPlayerProjectiles(),
          satelliteProjectiles: this.gameEngine
            .getActiveSatelliteProjectiles()
            .map((projectile) => ({ id: projectile.shotId, ...projectile })),
          collabTags: this.gameEngine
            .getActiveCollabTags()
            .map((tag) => ({ id: tag.asteroidId, ...tag })),
        });
        const recipientState =
          player.asteroidInteractions === 1
            ? canonical
            : captureSnapshot({ ...canonical, loot: compatibleLoot });
        const sequence = recipient.sequence + 1;
        const full =
          recipient.needsKeyframe || recipient.sinceKeyframe >= SNAPSHOT_KEYFRAME_INTERVAL;
        const frame = encodeSnapshot(
          recipientState,
          sequence,
          full ? undefined : recipient.baseline
        );
        recipient.pending = true;
        recipient.needsKeyframe = false;
        const deliveredState = recipientState;
        const recipientPlayerId = player.id;
        ws.send(
          JSON.stringify({ type: 'snapshot', data: frame, timestamp: message.timestamp }),
          (error) => {
            recipient.pending = false;
            if (error) {
              recipient.needsKeyframe = true;
              logger.error('Snapshot send failed; next send requires keyframe', error);
              return;
            }
            // Rejoin replaces the WeakMap entry; an old callback cannot advance it.
            if (this.snapshotRecipients.get(ws) !== recipient) {
              return;
            }
            recipient.sequence = sequence;
            recipient.baseline = { sequence, state: deliveredState };
            recipient.sinceKeyframe = frame.kind === 'keyframe' ? 0 : recipient.sinceKeyframe + 1;
            if (shouldSampleSnapshot(sequence)) {
              const authoritative = deliveredState.entities.find(
                (entity) => entity.id === recipientPlayerId
              );
              logger.info('STATE', 'snapshot_sent_to_transport', {
                releaseId: SERVER_RELEASE_ID,
                playerId: recipientPlayerId,
                sentAt: message.timestamp,
                gameTime: deliveredState.gameTime,
                snapshotSequence: sequence,
                snapshotKind: frame.kind,
                ...(frame.kind === 'delta' ? { snapshotBaseline: frame.baseline } : {}),
                ...(authoritative?.asteroidMotion
                  ? {
                      motionEpoch: authoritative.asteroidMotion.epoch,
                      motionAck: authoritative.asteroidMotion.ack,
                      motionMode: authoritative.asteroidMotion.mode,
                    }
                  : {}),
                ...(authoritative
                  ? { authoritativeRow: captureDiagnosticActorState(authoritative) }
                  : {}),
              });
            }
          }
        );
      } catch (error) {
        recipient.pending = false;
        recipient.needsKeyframe = true;
        logger.error('Failed to encode or send snapshot', error);
        // No partial state or silent format fallback after negotiation.
        this.closeFailedSnapshotSocket(ws);
      }
    }
  }

  private closeFailedSnapshotSocket(ws: WebSocket): void {
    try {
      ws.close(1011, 'Snapshot encoding failed');
    } catch (error) {
      logger.error('Failed to close snapshot socket', error);
    }
  }

  /** Called before joined; absent/unsupported offers preserve the exact legacy wire. */
  public negotiateSnapshot(ws: WebSocket, offer: unknown): 1 | undefined {
    this.snapshotRecipients.delete(ws);
    if (offer !== SNAPSHOT_VERSION) {
      return undefined;
    }
    this.snapshotRecipients.set(ws, {
      sequence: 0,
      sinceKeyframe: 0,
      pending: false,
      needsKeyframe: true,
    });
    return SNAPSHOT_VERSION;
  }

  public requestSnapshotKeyframe(ws: WebSocket): void {
    const recipient = this.snapshotRecipients.get(ws);
    if (recipient) {
      // Coalesce requests; the periodic broadcast supplies the keyframe.
      recipient.needsKeyframe = true;
    }
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

  public broadcastPlayerJoined(
    playerId: string,
    playerName: string,
    position: { x: number; y: number }
  ): void {
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

  public broadcastPlayerUpdate(playerId: string, updateData: PlayerUpdateData): void {
    const message = {
      type: 'playerUpdate',
      data: { id: playerId, ...updateData },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message, playerId);
  }

  public broadcastSatelliteShoot(shot: {
    id: string;
    shotId: string;
    laserStart: { x: number; y: number };
    laserDirection: { x: number; y: number };
  }): void {
    this.broadcastToAll({
      type: 'satelliteShoot',
      data: shot,
      timestamp: Date.now(),
    });
  }

  public broadcastPlayerShoot(
    playerId: string,
    laserStart: Position,
    laserDirection: Velocity,
    shotId?: string
  ): void {
    const timestamp = Date.now();
    const message = {
      type: 'playerShoot',
      data: {
        id: playerId,
        laserStart,
        laserDirection,
        ...(shotId ? { shotId } : {}),
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
      this.broadcastAsteroidDestruction(
        result.destroyedAsteroidId,
        result.origin !== undefined
          ? { collabSplit: result.collabSplit === true, origin: result.origin }
          : { collabSplit: result.collabSplit === true }
      );
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

  public broadcastPlayerKilled(
    targetPlayerId: string,
    targetPlayerName: string,
    attackerId: string
  ): void {
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

  public broadcastSatellitePickupCollected(data: {
    pickupId: string;
    playerId: string;
    playerName: string;
    pickupName: 'Echo' | 'Relay';
    scoreBonus: number;
    shieldFrames: number;
  }): void {
    this.broadcastToAll({
      type: 'satellitePickupCollected',
      data,
      timestamp: Date.now(),
    });
  }

  public broadcastAsteroidCreation(asteroids: readonly AsteroidData[]): void {
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
        ...(extras?.origin !== undefined ? { origin: extras.origin } : {}),
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastShockwave(event: {
    origin: { x: number; y: number };
    asteroidId?: string;
  }): void {
    const message = {
      type: 'shockwave',
      data: {
        origin: { x: event.origin.x, y: event.origin.y },
        ...(event.asteroidId !== undefined ? { asteroidId: event.asteroidId } : {}),
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

  public broadcastAsteroidUpdate(asteroidId: string, updates: AsteroidUpdateData): void {
    const message = {
      type: 'asteroidUpdate',
      data: { asteroidId, updates },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastBotUpdate(botId: string): void {
    const bot = this.gameEngine.getBot(botId);
    if (bot) {
      const data = {
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
        ...(bot.factionId !== undefined ? { factionId: bot.factionId } : {}),
        abilityCooldownFrames: bot.abilityCooldownFrames,
        abilityActiveFrames: bot.abilityActiveFrames,
        shieldTimer: bot.shieldTimer,
        harpoonTimer: bot.harpoonTimer,
        ...(bot.harpoonTargetId !== undefined ? { harpoonTargetId: bot.harpoonTargetId } : {}),
        ...(bot.harpoonLatchPos !== undefined ? { harpoonLatchPos: bot.harpoonLatchPos } : {}),
        shieldActive: bot.shieldActive,
        shieldTime: bot.shieldTime,
        shieldCooldown: bot.shieldCooldown,
        shieldFlashTime: bot.shieldFlashTime,
      };
      const message = {
        type: 'botUpdate',
        data,
        timestamp: Date.now(),
      };

      this.broadcastToAll(message);
    }
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

  public sendToWebSocket(ws: WebSocket, message: unknown): void {
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

  public broadcastToAll(message: unknown, excludeId?: string): void {
    let messageStr: string;
    try {
      messageStr = JSON.stringify(message);
    } catch (error) {
      // A circular Timeout on player.ws used to kill the process here and
      // flap every client into the Reconnecting banner (#485 live miss).
      logger.error('Failed to serialize broadcast', {
        type: messageType(message),
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
          logger.error(
            `Failed to send message to player ${player.id} (readyState: ${player.ws.readyState})`,
            error
          );
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
