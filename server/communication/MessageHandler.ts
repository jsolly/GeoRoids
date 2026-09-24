import type { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import { isClientOwnedCollisionAttacker } from '../../shared/combat';
import { scoutAbilityBuildsAt } from '../../shared/furnaceField';
import { isTownSquareArrival } from '../../shared/furnaces';
import { MAX_TICK_DEBT_MS } from '../../shared/gameClock';
import { nearbyWorldRows } from '../../shared/world';
import type { AbilityUsedEvent, PlayerShotAcknowledgement } from '../../shared-types';
import { getShipKit } from '../../src/entities/ship/shipKits';
import { sanitizePlayerName } from '../../src/utils/playerName';
import type { GameEntity } from '../core/EntityManager';
import type { AppliedAsteroidHit, GameEngine } from '../core/GameEngine';
import type { MotionOutcome } from '../core/PlayerMotionService';
import { SERVER_RELEASE_ID } from '../release';
import { ClientLogger } from '../services/ClientLogger';
import type { GameStateBroadcaster } from '../services/GameStateBroadcaster';
import { type ClientCommand, decodeClientCommand } from './clientCommandDecoder';

type CommandOf<Type extends ClientCommand['type']> = Extract<ClientCommand, { type: Type }>;

export class MessageHandler {
  private gameEngine: GameEngine;
  private broadcaster: GameStateBroadcaster;
  private joinAttempts = new WeakMap<WebSocket, { startedAt: number; count: number }>();
  private motionRejections = new WeakMap<
    WebSocket,
    { lastThrottleAt: number; suppressed: number }
  >();
  private snapshotResyncLogs = new WeakMap<
    WebSocket,
    { lastThrottleAt: number; suppressed: number }
  >();

  constructor(gameEngine: GameEngine, broadcaster: GameStateBroadcaster) {
    this.gameEngine = gameEngine;
    this.broadcaster = broadcaster;
  }

  public handleMessage(message: unknown, ws: WebSocket): void {
    if (!this.gameEngine.isPersistenceHealthy()) {
      this.broadcaster.sendError(ws, 'World storage unavailable; server restarting');
      return;
    }
    const decoded = decodeClientCommand(message);
    if (!decoded.ok) {
      if (decoded.logUnknown) {
        logger.warn(`Unknown message type: ${decoded.messageType}`);
      }
      if (decoded.error) {
        this.broadcaster.sendError(ws, decoded.error);
      }
      return;
    }
    const command = decoded.command;
    const commandType = command.type;
    if (
      this.gameEngine.getPlayerBySocket(ws)?.furnaceTransit &&
      [
        'update',
        'shoot',
        'collisionDamage',
        'useAbility',
        'equipSatellite',
        'setHaulerUtility',
        'setScoutUtility',
        'buyShipPaint',
        'buyExtraLife',
      ].includes(commandType)
    ) {
      return;
    }

    try {
      switch (commandType) {
        case 'join':
          this.handleJoin(ws, command);
          break;

        case 'leave': {
          const owner = this.gameEngine.getPlayerBySocket(ws);
          if (owner) {
            this.gameEngine.removePlayer(owner.id);
            this.broadcaster.broadcastPlayerLeft(owner.id);
          }
          break;
        }

        case 'snapshotResync':
          if (this.gameEngine.getPlayerBySocket(ws)) {
            this.logSnapshotResync(ws, Date.now(), this.gameEngine.getServerTime());
            this.broadcaster.requestSnapshotKeyframe(ws);
          }
          break;

        case 'travelFurnace': {
          const owner = this.gameEngine.getPlayerBySocket(ws);
          if (owner?.id !== command.id) {
            break;
          }
          const issue = this.gameEngine.travelFurnace(command.id, command.destinationId);
          ws.send(
            JSON.stringify({
              type: 'furnaceTravelResult',
              data: { ok: !issue, message: issue ?? 'Travelling' },
              timestamp: this.gameEngine.getServerTime(),
            })
          );
          if (!issue) {
            this.broadcaster.broadcastGameState();
          }
          break;
        }

        case 'useAbility':
          this.handleUseAbility(ws, command);
          break;

        case 'equipSatellite': {
          const player = this.gameEngine.getPlayerBySocket(ws);
          if (
            player?.id === command.id &&
            this.gameEngine.equipSatellite(command.id, command.pickupId)
          ) {
            this.broadcaster.broadcastGameState();
          }
          break;
        }
        case 'setHaulerUtility':
          this.handleSetHaulerUtility(ws, command);
          break;
        case 'setScoutUtility':
          this.handleSetScoutUtility(ws, command);
          break;
        case 'buyStoreItem':
          this.handleBuyStoreItem(ws, command);
          break;

        case 'update':
          this.handlePlayerUpdate(ws, command);
          break;

        case 'shoot':
          this.handlePlayerShoot(ws, command);
          break;

        case 'chat':
          this.handleChat(ws, command);
          break;

        case 'collisionDamage':
          this.handleCollisionDamage(ws, command);
          break;

        case 'initAsteroids':
          this.handleInitAsteroids(ws, command);
          break;

        case 'clientLog':
          ClientLogger.logClientMessage(command.payload, ws);
          break;

        case 'ping':
          this.handlePing(ws, command.probeId);
          break;

        default:
          throw new Error(`Unexpected client command type: ${commandType}`);
      }
    } catch (error) {
      logger.error(
        'Error handling message',
        {
          messageType: commandType,
          messageId: 'id' in command ? command.id : '<missing>',
        },
        error
      );
      this.broadcaster.sendError(ws, 'Internal server error');
    }
  }

  private handleJoin(ws: WebSocket, command: CommandOf<'join'>): void {
    let { id, name } = command;
    logger.debug('Handling join message', { playerId: id });
    const now = Date.now();
    let attempts = this.joinAttempts.get(ws);
    if (!attempts || now - attempts.startedAt >= 10_000) {
      attempts = { startedAt: now, count: 0 };
      this.joinAttempts.set(ws, attempts);
    }
    if (++attempts.count > 5) {
      ws.close(1008, 'Too many join requests');
      return;
    }

    name = sanitizePlayerName(name);
    if (!name) {
      this.broadcaster.sendError(ws, 'Player ID or name is missing or invalid');
      return;
    }

    logger.debug('Player join', {
      id,
      position: command.position,
      kitId: command.kitId,
    });

    let resumeToken: string | undefined;
    let player: GameEntity;
    let resumedSession = false;
    if (command.resumeRequested) {
      // A bearer token may move a session between sockets, but it must never
      // merge that session into a socket already carrying another pilot.
      const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
      if (socketPlayer && socketPlayer.id !== id) {
        this.broadcaster.sendError(ws, 'Resume requires a dedicated gameplay socket');
        return;
      }
      const resumed = this.gameEngine.resumePilot(
        command.resumeToken ?? '',
        ws,
        command.kitId,
        name,
        command.clientReleaseId
      );
      if (!resumed.ok) {
        this.broadcaster.sendToWebSocket(ws, { type: 'sessionExpired', timestamp: Date.now() });
        return;
      }
      player = resumed.actor;
      resumedSession = true;
      id = player.id;
      name = player.name;
      resumeToken = resumed.resumeToken;
      resumed.supersededSocket?.close(4001, 'Session moved to another socket');
    } else {
      const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
      if (socketPlayer && socketPlayer.id !== id) {
        this.broadcaster.sendError(ws, 'A gameplay socket can only own one pilot');
        return;
      }
      const conflictingPilot = this.gameEngine
        .getAllPlayers()
        .find(
          (candidate) => candidate.id === id || candidate.name.toLowerCase() === name.toLowerCase()
        );
      if (conflictingPilot || this.gameEngine.hasSavedPilot(id)) {
        this.broadcaster.sendError(ws, 'This pilot requires its private resume token');
        return;
      }
      if (this.gameEngine.getAllPlayers().length >= 100) {
        this.broadcaster.sendError(ws, 'The game server is full');
        return;
      }
      const arrival =
        command.position && isTownSquareArrival(command.position) ? command.position : undefined;
      player = this.gameEngine.addPlayer(id, name, ws, arrival, command.kitId);
      player.asteroidInteractions = 1;
      const registered = this.gameEngine.registerPilot(player, ws, command.clientReleaseId);
      if (!registered.ok) {
        this.gameEngine.removePlayer(player.id);
        this.broadcaster.sendError(ws, registered.error);
        return;
      }
      resumeToken = registered.resumeToken;
      this.gameEngine.enableAsteroidInteractions(player);
    }

    const snapshotVersion = this.broadcaster.negotiateSnapshot(ws);
    const provenance = this.gameEngine.getPilotReleaseProvenance(id);

    // Send confirmation to the joining player
    this.broadcaster.sendToWebSocket(ws, {
      type: 'joined',
      data: {
        id,
        name,
        position: player.position,
        resumeToken,
        asteroidInteractions: 1,
        shotAcknowledgements: true,
        color: player.color,
        kitId: player.kitId,
        terrainSeed: this.gameEngine.getTerrainSeed(),
        serverReleaseId: SERVER_RELEASE_ID,
        snapshotVersion,
        ...provenance,
      },
      timestamp: Date.now(),
    });
    if (
      provenance.credentialReleaseId !== undefined &&
      provenance.credentialReleaseId !== SERVER_RELEASE_ID
    ) {
      logger.info('STATE', 'pilot_credential_from_prior_release', {
        releaseId: SERVER_RELEASE_ID,
        playerId: id,
        credentialReleaseId: provenance.credentialReleaseId,
        ...(provenance.scoreReleaseId ? { scoreReleaseId: provenance.scoreReleaseId } : {}),
        ...(command.clientReleaseId ? { clientReleaseId: command.clientReleaseId } : {}),
      });
    }
    logger.info('STATE', 'player_joined', {
      releaseId: SERVER_RELEASE_ID,
      playerId: id,
      joinedAt: Date.now(),
      gameTime: this.gameEngine.getDiagnostics().gameTime,
      resumed: resumedSession,
      enhanced: player.asteroidInteractions === 1,
      snapshotVersion,
      ...provenance,
      ...(command.clientReleaseId ? { clientReleaseId: command.clientReleaseId } : {}),
      ...(player.playerMotion
        ? {
            motionEpoch: player.playerMotion.epoch,
            motionAck: player.playerMotion.ack,
            motionMode: player.playerMotion.mode,
          }
        : {}),
    });
    logger.debug('📤 Sent joined confirmation', { playerId: id });

    // Broadcast to all other players
    this.broadcaster.broadcastPlayerJoined(id, name, player.position);
    this.broadcaster.broadcastGameState();
    logger.debug('📢 Broadcasted player joined and game state', { playerId: id });
  }

  private handlePlayerUpdate(ws: WebSocket, command: CommandOf<'update'>): void {
    const { id, update } = command;
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (!socketPlayer || socketPlayer.id !== id) {
      return;
    }

    this.gameEngine.setOverlayHold(id, update.overlayHold === true);

    // Ignore movement updates while the player is dead, exploding, or waiting to
    // respawn. Otherwise the client's stale position keeps overwriting the
    // server-chosen respawn position, leaving the ship frozen where it died
    // (e.g. stuck outside the boundary at full health). Overlay hold still
    // latches above so closing a menu during that window cannot stick forever.
    const held = this.gameEngine.getPlayer(id);
    if (held && (held.exploding || held.respawnTimer !== undefined || held.health <= 0)) {
      return;
    }
    if (held?.overlayHold === true) {
      update.position = { ...held.position };
      update.velocity = { x: 0, y: 0 };
      update.thrusting = false;
      update.boosting = false;
    }

    if (
      command.motionEpoch === undefined ||
      command.motionSequence === undefined ||
      update.position === undefined ||
      update.velocity === undefined ||
      update.angle === undefined ||
      update.thrusting === undefined
    ) {
      // A pose queued before join acknowledgment has no motion epoch yet.
      // Ignore it without changing authoritative state or reporting a false failure.
      return;
    }
    const beforeMode = socketPlayer.playerMotion?.mode;
    const receivedAt = Date.now();
    const motionNow = this.gameEngine.getServerTime();
    const outcome = this.gameEngine.playerMotion.acceptFreePose(
      ws,
      {
        epoch: command.motionEpoch,
        sequence: command.motionSequence,
        position: update.position,
        velocity: update.velocity,
        angle: update.angle,
        thrusting: update.thrusting,
        boosting: update.boosting === true,
        boostDepleted: update.boostDepleted === true,
      },
      motionNow
    );
    this.logMotionRejection(
      ws,
      'update',
      outcome,
      receivedAt,
      command.motionEpoch,
      command.motionSequence,
      motionNow
    );
    if (outcome.ok && beforeMode === 'handoff') {
      this.logMotionTransition(
        ws,
        'motion_handoff_acknowledged',
        receivedAt,
        command.motionSequence
      );
    }
    // Only the first pose after a block carries its credit, so this fires once
    // per session per stall and marks where the old one-second cap would have
    // rebased an honest pilot.
    if (outcome.ok && outcome.blockedMs >= MAX_TICK_DEBT_MS) {
      logger.warn('STATE', 'motion_blocked_time_credited', {
        releaseId: SERVER_RELEASE_ID,
        playerId: socketPlayer.id,
        receivedAt,
        gameTime: this.gameEngine.getDiagnostics().gameTime,
        receivedSequence: command.motionSequence,
        blockedMs: outcome.blockedMs,
      });
    }
  }

  private handlePlayerShoot(ws: WebSocket, command: CommandOf<'shoot'>): void {
    const { id, laserStart, laserDirection, requestId } = command;
    logger.debug('DEBUG: Server received shoot message', { id, laserStart, laserDirection });

    const shooter = this.gameEngine.getPlayerBySocket(ws);
    if (!shooter || shooter.id !== id) {
      return;
    }

    const laser = this.gameEngine.spawnPlayerLaser(shooter.id, laserStart, laserDirection);
    if (requestId !== undefined) {
      const acknowledgement: PlayerShotAcknowledgement = {
        requestId,
        projectileId: laser?.id ?? null,
      };
      this.broadcaster.sendToWebSocket(ws, {
        type: 'shotAcknowledged',
        data: acknowledgement,
        timestamp: Date.now(),
      });
    }
    if (!laser) {
      return;
    }

    this.broadcastAppliedAsteroidHits(this.gameEngine.resolveSpawnedLaserHits(laser.id));
  }

  private handleChat(ws: WebSocket, command: CommandOf<'chat'>): void {
    const { id, message } = command;
    const player = this.gameEngine.getPlayerBySocket(ws);
    if (player && player.id === id) {
      this.broadcaster.broadcastChatMessage(player.id, player.name, message);
    }
  }

  private getReporterId(ws: WebSocket): string | undefined {
    return this.gameEngine.getPlayerBySocket(ws)?.id;
  }

  private emitShipDamage(
    targetId: string,
    attackerId: string,
    damage: number,
    healthBefore: number | undefined
  ): void {
    const outcome = this.gameEngine.handleShipDamage(targetId, attackerId, damage);
    if (!outcome.applied || !outcome.entity) {
      return;
    }
    const healthDropped = healthBefore !== undefined && outcome.entity.health < healthBefore;
    if (!outcome.isDestroyed && !healthDropped) {
      return;
    }
    this.broadcaster.broadcastCombatResult({
      targetId,
      attackerId,
      damage,
      remainingHealth: outcome.entity.health,

      isDestroyed: outcome.isDestroyed,
      targetType: outcome.entity.type,
    });
  }

  private handleCollisionDamage(ws: WebSocket, command: CommandOf<'collisionDamage'>): void {
    const { targetPlayerId, attackerId } = command;
    logger.debug('handleCollisionDamage', { targetPlayerId });

    // Asteroid impacts are resolved by the server. Clients report only their boundary hit.
    if (!isClientOwnedCollisionAttacker(attackerId)) {
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || reporterId !== targetPlayerId) {
      return;
    }

    const before = this.gameEngine.getPlayer(targetPlayerId);
    if (before) {
      this.emitShipDamage(targetPlayerId, 'boundary', before.health, before.health);
    }
  }

  private handleSetHaulerUtility(ws: WebSocket, command: CommandOf<'setHaulerUtility'>): void {
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (!socketPlayer || socketPlayer.id !== command.id || socketPlayer.kitId !== 'hauler') {
      return;
    }
    if (!this.gameEngine.setHaulerUtility(command.id, command.utilityId)) {
      return;
    }
    this.broadcaster.broadcastGameState();
  }

  private handleBuyStoreItem(ws: WebSocket, command: CommandOf<'buyStoreItem'>): void {
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (!socketPlayer || socketPlayer.id !== command.id) {
      return;
    }
    const issue = this.gameEngine.buyStoreItem(command.id, command.offerId);
    const pilot = this.gameEngine.getPlayer(command.id);
    ws.send(
      JSON.stringify({
        type: 'townStoreResult',
        data: issue
          ? { message: issue }
          : {
              message: this.gameEngine.townStoreNotice(command.offerId),
              score: pilot?.score,
              purchases: pilot?.purchases,
            },
        timestamp: Date.now(),
      })
    );
    if (!issue) {
      this.broadcaster.broadcastGameState();
    }
  }

  private handleSetScoutUtility(ws: WebSocket, command: CommandOf<'setScoutUtility'>): void {
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (!socketPlayer || socketPlayer.id !== command.id || socketPlayer.kitId !== 'scout') {
      return;
    }
    if (!this.gameEngine.setScoutUtility(command.id, command.utilityId)) {
      return;
    }
    this.broadcaster.broadcastGameState();
  }

  private handleUseAbility(ws: WebSocket, command: CommandOf<'useAbility'>): void {
    const playerId = command.id;
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (!socketPlayer || socketPlayer.id !== playerId) {
      return;
    }
    // The join payload selects the kit. An ability request may echo that
    // selection for compatibility, but it cannot change authoritative ship
    // stats after the socket has joined.
    if (command.kitId !== undefined && command.kitId !== socketPlayer.kitId) {
      return;
    }
    const latchedTarget = socketPlayer.harpoonTargetId
      ? this.gameEngine.getAsteroid(socketPlayer.harpoonTargetId)
      : undefined;
    const wasArmed = latchedTarget?.boost?.phase === 'armed';
    const offeringBuild =
      socketPlayer.kitId === 'scout' &&
      scoutAbilityBuildsAt(socketPlayer.position, (id) => this.gameEngine.isFurnaceLit(id));
    const activated = this.gameEngine.useAbility(playerId, command.kitId);
    if (offeringBuild) {
      ws.send(
        JSON.stringify({
          type: 'furnaceBuildResult',
          data: activated
            ? this.gameEngine.furnaceBuildNotice()
            : (this.gameEngine.furnaceBuildIssue(playerId) ?? 'Furnace builder not ready'),
          timestamp: Date.now(),
        })
      );
    }
    if (!activated) {
      return;
    }
    const entity = this.gameEngine.getPlayer(playerId);
    if (!entity) {
      return;
    }
    const sentAt = Date.now();
    this.broadcaster.broadcastToAll({
      type: 'abilityUsed',
      data: {
        id: playerId,
        kitId: entity.kitId,
        abilityId: getShipKit(entity.kitId).abilityId,
        ...(entity.harpoonTargetId !== undefined
          ? { harpoonTargetId: entity.harpoonTargetId }
          : {}),
        ...(entity.harpoonLatchPos !== undefined
          ? { harpoonLatchPos: entity.harpoonLatchPos }
          : {}),

        abilityActiveFrames: entity.abilityActiveFrames,
        ...(wasArmed && latchedTarget?.boost?.phase === 'burning'
          ? { boostIgnitionPosition: { ...latchedTarget.position } }
          : {}),
      } satisfies AbilityUsedEvent,
      timestamp: sentAt,
    });
    this.broadcaster.broadcastGameState();
  }

  public broadcastAppliedAsteroidHits(hits: AppliedAsteroidHit[]): void {
    for (const hit of hits) {
      if (!hit.applied) {
        continue;
      }

      if (hit.outcome === 'tagged' && hit.expiresAt) {
        this.broadcaster.broadcastAsteroidTagged({
          asteroidId: hit.asteroidId,
          shooterId: hit.playerId,
          expiresAt: hit.expiresAt,
        });
        continue;
      }

      if (hit.outcome !== 'destroyed') {
        continue;
      }

      const scorer = this.gameEngine.getPlayer(hit.playerId);
      if (scorer) {
        this.broadcaster.broadcastScoreUpdate(scorer.id, scorer.score);
      }

      this.broadcaster.broadcastAsteroidDestruction(
        hit.asteroidId,
        hit.origin !== undefined
          ? { collabSplit: hit.split, origin: hit.origin }
          : { collabSplit: hit.split }
      );

      if (hit.split && hit.origin) {
        this.gameEngine.queueCollabShockwave(hit.origin);
        this.broadcaster.broadcastShockwave({
          origin: hit.origin,
          asteroidId: hit.asteroidId,
        });
      }

      if (hit.newAsteroids.length > 0) {
        this.broadcaster.broadcastAsteroidCreation(hit.newAsteroids);
      }
    }
  }

  private handleInitAsteroids(ws: WebSocket, command: CommandOf<'initAsteroids'>): void {
    const { id } = command;
    logger.debug('Handling initAsteroids message', { id });

    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (!socketPlayer || socketPlayer.id !== id) {
      return;
    }

    // The active server owns field creation and replenishment. This message
    // is an idempotent resync for reconnecting clients.
    const created = this.gameEngine.ensureAsteroidField();
    if (created.length > 0) {
      this.broadcaster.broadcastAsteroidCreation(created);
      logger.debug('Player received the newly seeded asteroid field', { playerId: id });
      return;
    }

    const existingAsteroids = nearbyWorldRows(
      this.gameEngine.getAllAsteroids(),
      socketPlayer.position
    );
    this.broadcaster.sendToWebSocket(ws, {
      type: 'asteroidCreateBatch',
      data: {
        asteroids: existingAsteroids,
      },
      timestamp: Date.now(),
    });
    logger.debug('Player requested asteroid initialization', {
      playerId: id,
      asteroidCount: existingAsteroids.length,
    });
  }

  private handlePing(ws: WebSocket, probeId: number | undefined): void {
    this.broadcaster.sendToWebSocket(ws, {
      type: 'pong',
      timestamp: Date.now(),
      ...(probeId === undefined ? {} : { probeId }),
    });
  }

  private logMotionRejection(
    ws: WebSocket,
    commandType: 'update',
    outcome: MotionOutcome,
    receivedAt: number,
    receivedEpoch?: number,
    receivedSequence?: number,
    throttleAt = this.gameEngine.getServerTime()
  ): void {
    if (outcome.ok) {
      return;
    }
    const previous = this.motionRejections.get(ws);
    if (previous && throttleAt - previous.lastThrottleAt < 5000) {
      previous.suppressed += 1;
      return;
    }
    const owner = this.gameEngine.getPlayerBySocket(ws);
    const motion = owner ? this.gameEngine.playerMotion.getState(owner.id) : undefined;
    logger.warn('STATE', 'motion_command_rejected', {
      releaseId: SERVER_RELEASE_ID,
      playerId: owner?.id,
      receivedAt,
      gameTime: this.gameEngine.getDiagnostics().gameTime,
      commandType,
      reason: outcome.error,
      ...(receivedEpoch !== undefined ? { receivedEpoch } : {}),
      ...(receivedSequence !== undefined ? { receivedSequence } : {}),
      ...(motion
        ? { motionEpoch: motion.epoch, motionAck: motion.ack, motionMode: motion.mode }
        : {}),
      ...(outcome.envelope ? { envelope: outcome.envelope } : {}),
      ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}),
    });
    this.motionRejections.set(ws, { lastThrottleAt: throttleAt, suppressed: 0 });
  }

  private logSnapshotResync(ws: WebSocket, receivedAt: number, throttleAt: number): void {
    const previous = this.snapshotResyncLogs.get(ws);
    if (previous && throttleAt - previous.lastThrottleAt < 5000) {
      previous.suppressed += 1;
      return;
    }
    const owner = this.gameEngine.getPlayerBySocket(ws);
    logger.info('STATE', 'snapshot_resync_requested', {
      releaseId: SERVER_RELEASE_ID,
      playerId: owner?.id,
      receivedAt,
      gameTime: this.gameEngine.getDiagnostics().gameTime,
      ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}),
    });
    this.snapshotResyncLogs.set(ws, { lastThrottleAt: throttleAt, suppressed: 0 });
  }

  private logMotionTransition(
    ws: WebSocket,
    event: 'motion_handoff_acknowledged',
    observedAt: number,
    sequence: number
  ): void {
    const owner = this.gameEngine.getPlayerBySocket(ws);
    if (!owner) {
      return;
    }
    const motion = this.gameEngine.playerMotion.getState(owner.id);
    logger.info('STATE', event, {
      releaseId: SERVER_RELEASE_ID,
      playerId: owner.id,
      observedAt,
      gameTime: this.gameEngine.getDiagnostics().gameTime,
      sequence,
      ...(motion
        ? { motionEpoch: motion.epoch, motionAck: motion.ack, motionMode: motion.mode }
        : {}),
    });
  }
}
