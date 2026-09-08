import type { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import {
  clampLaserDamage,
  isAllowedLaserReporter,
  isClientOwnedCollisionAttacker,
  isServerOwnedRamAttacker,
} from '../../shared/combat';
import { LOOT_BLAST } from '../../shared/lootBlast';
import { GROWTH, radiusFromMass } from '../../shared/shipGrowth';
import { DAMAGE, SATELLITE_PICKUP } from '../../src/constants';
import type { CombatDamageSource } from '../../src/entities/ship/shipShield';
import type { MotionOutcome } from '../core/AsteroidMotionService';
import { type GameEntity, isStaleDeathPose } from '../core/EntityManager';
import type { AppliedAsteroidHit, GameEngine } from '../core/GameEngine';
import { SERVER_RELEASE_ID } from '../release';
import { ClientLogger } from '../services/ClientLogger';
import type { GameStateBroadcaster } from '../services/GameStateBroadcaster';
import { type ClientCommand, decodeClientCommand } from './clientCommandDecoder';

type CommandOf<Type extends ClientCommand['type']> = Extract<ClientCommand, { type: Type }>;

export class MessageHandler {
  private gameEngine: GameEngine;
  private broadcaster: GameStateBroadcaster;
  private joinAttempts = new WeakMap<WebSocket, { startedAt: number; count: number }>();
  private motionRejections = new WeakMap<WebSocket, { lastLoggedAt: number; suppressed: number }>();
  private snapshotResyncLogs = new WeakMap<
    WebSocket,
    { lastLoggedAt: number; suppressed: number }
  >();

  constructor(
    gameEngine: GameEngine,
    broadcaster: GameStateBroadcaster,
    private requireEnhancedClient = false
  ) {
    this.gameEngine = gameEngine;
    this.broadcaster = broadcaster;
  }

  public handleMessage(message: unknown, ws: WebSocket): void {
    const decoded = decodeClientCommand(message);
    if (!decoded.ok) {
      if (decoded.logUnknown) {
        logger.warn(`Unknown message type: ${decoded.messageType}`);
      }
      if (
        decoded.error &&
        !(
          decoded.suppressWhenAuthoritativeProjectiles &&
          this.gameEngine.usesAuthoritativeProjectiles()
        )
      ) {
        this.broadcaster.sendError(ws, decoded.error);
      }
      return;
    }
    const command = decoded.command;

    try {
      switch (command.type) {
        case 'join':
          this.handleJoin(ws, command);
          break;

        case 'leave': {
          const owner = this.gameEngine.getPlayerBySocket(ws);
          if (owner?.type === 'human') {
            this.gameEngine.removePlayer(owner.id);
            this.broadcaster.broadcastPlayerLeft(owner.id);
          }
          break;
        }

        case 'asteroidTool': {
          const receivedAt = Date.now();
          const outcome = this.gameEngine.asteroidMotion.latch(
            ws,
            command.action,
            this.gameEngine.getAllAsteroids(),
            receivedAt
          );
          this.logMotionRejection(
            ws,
            'asteroidTool',
            outcome,
            receivedAt,
            undefined,
            command.action.sequence
          );
          if (outcome.ok) {
            this.logMotionTransition(ws, 'motion_latched', receivedAt, command.action.sequence);
            this.broadcaster.broadcastGameState();
          }
          break;
        }

        case 'asteroidInput': {
          const receivedAt = Date.now();
          const outcome = this.gameEngine.asteroidMotion.input(
            ws,
            command.input,
            this.gameEngine.getAllAsteroids(),
            receivedAt
          );
          this.logMotionRejection(
            ws,
            'asteroidInput',
            outcome,
            receivedAt,
            command.input.epoch,
            command.input.sequence
          );
          if (outcome.ok && command.input.action) {
            this.logMotionTransition(
              ws,
              'motion_action_accepted',
              receivedAt,
              command.input.sequence,
              command.input.action
            );
          }
          break;
        }

        case 'snapshotResync':
          if (this.gameEngine.getPlayerBySocket(ws)?.type === 'human') {
            this.logSnapshotResync(ws, Date.now());
            this.broadcaster.requestSnapshotKeyframe(ws);
          }
          break;

        case 'useAbility':
          this.handleUseAbility(ws, command);
          break;

        case 'asteroidDamage':
          this.handleAsteroidDamage(ws, command);
          break;

        case 'update':
          this.handlePlayerUpdate(ws, command);
          break;

        case 'shoot':
          this.handlePlayerShoot(ws, command);
          break;

        case 'shield':
          this.handleShield(ws, command);
          break;

        case 'chat':
          this.handleChat(ws, command);
          break;

        case 'laserDamage':
          this.handleLaserDamage(ws, command);
          break;

        case 'collisionDamage':
          this.handleCollisionDamage(ws, command);
          break;

        case 'botDamage':
          this.handleBotDamage(ws, command);
          break;

        case 'satelliteDamage':
          this.handleSatelliteDamage(ws, command);
          break;

        case 'satellitePickupCollected':
          this.handleSatellitePickupCollected(ws, command);
          break;

        case 'asteroidDestroyed':
          this.handleAsteroidDestroyed(ws, command);
          break;

        case 'lootExplode':
          this.handleLootExplode(ws, command);
          break;

        case 'initAsteroids':
          this.handleInitAsteroids(ws, command);
          break;

        case 'botUpdate':
          this.handleBotUpdate(ws, command);
          break;

        case 'clientLog':
          ClientLogger.logClientMessage(command.payload, ws);
          break;

        case 'ping':
          this.handlePing(ws);
          break;
      }
    } catch (error) {
      logger.error(
        'Error handling message',
        {
          messageType: command.type,
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

    logger.debug('Player join', {
      id,
      position: command.position,
      kitId: command.kitId,
      factionId: command.factionId,
    });

    if (this.requireEnhancedClient && (!command.enhancedOffer || command.snapshotVersion !== 1)) {
      this.broadcaster.sendError(ws, 'Client update required; refresh GeoRoids');
      return;
    }
    let resumeToken: string | undefined;
    let player: GameEntity;
    let resumedSession = false;
    if (command.resumeRequested) {
      if (!command.enhancedOffer || command.snapshotVersion !== 1) {
        this.broadcaster.sendError(ws, 'Resume requires the enhanced snapshot capability');
        return;
      }
      // A bearer token may move an enhanced session between sockets, but it
      // must never merge that session into a socket which is already carrying
      // a legacy human. EntityManager resolves socket ownership by scanning
      // entity rows, so allowing both bindings would make later updates
      // ambiguous and could strand the resumed pilot.
      const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
      if (socketPlayer && socketPlayer.asteroidInteractions !== 1) {
        this.broadcaster.sendError(ws, 'Resume requires a dedicated gameplay socket');
        return;
      }
      const resumed = this.gameEngine.asteroidMotion.resume(
        command.resumeToken ?? '',
        ws,
        Date.now()
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
      if (conflictingPilot?.asteroidInteractions === 1) {
        this.broadcaster.sendError(ws, 'This pilot requires its private resume token');
        return;
      }
      const reusableHuman = this.gameEngine
        .getAllPlayers()
        .find(
          (candidate) =>
            candidate.type === 'human' && (candidate.id === id || candidate.name === name)
        );
      if (
        !reusableHuman &&
        this.gameEngine.getAllPlayers().filter((actor) => actor.type === 'human').length >= 100
      ) {
        this.broadcaster.sendError(ws, 'The game server is full');
        return;
      }
      player = this.gameEngine.addPlayer(
        id,
        name,
        ws,
        command.position,
        undefined,
        command.kitId,
        command.factionId
      );
      if (command.enhancedOffer && command.snapshotVersion === 1) {
        player.asteroidInteractions = 1;
        const registered = this.gameEngine.asteroidMotion.register(player, ws, 1, Date.now());
        if (!registered.ok) {
          this.gameEngine.removePlayer(player.id);
          this.broadcaster.sendError(ws, registered.error);
          return;
        }
        resumeToken = registered.resumeToken;
        this.gameEngine.enableAsteroidInteractions(player);
      }
    }
    const replacedId = this.gameEngine.consumeReplacedHumanId();
    if (replacedId) {
      this.broadcaster.broadcastPlayerLeft(replacedId);
    }

    const snapshotVersion = this.broadcaster.negotiateSnapshot(ws, command.snapshotVersion);

    // Send confirmation to the joining player
    this.broadcaster.sendToWebSocket(ws, {
      type: 'joined',
      data: {
        id,
        name,
        position: player.position,
        ...(resumeToken ? { resumeToken, asteroidInteractions: 1 } : {}),
        color: player.color,
        kitId: player.kitId,
        ...(player.factionId !== undefined ? { factionId: player.factionId } : {}),
        terrainSeed: this.gameEngine.getTerrainSeed(),
        serverReleaseId: SERVER_RELEASE_ID,
        ...(snapshotVersion ? { snapshotVersion } : {}),
      },
      timestamp: Date.now(),
    });
    logger.info('STATE', 'player_joined', {
      releaseId: SERVER_RELEASE_ID,
      playerId: id,
      joinedAt: Date.now(),
      gameTime: this.gameEngine.getDiagnostics().gameTime,
      resumed: resumedSession,
      enhanced: player.asteroidInteractions === 1,
      ...(snapshotVersion !== undefined ? { snapshotVersion } : {}),
      ...(player.asteroidMotion
        ? {
            motionEpoch: player.asteroidMotion.epoch,
            motionAck: player.asteroidMotion.ack,
            motionMode: player.asteroidMotion.mode,
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
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== id) {
      return;
    }

    // Ignore movement updates while the player is dead, exploding, or waiting to
    // respawn. Otherwise the client's stale position keeps overwriting the
    // server-chosen respawn position, leaving the ship frozen where it died
    // (e.g. stuck outside the boundary at full health).
    const existing = this.gameEngine.getPlayer(id);
    if (
      existing &&
      (existing.exploding || existing.respawnTimer !== undefined || existing.health <= 0)
    ) {
      return;
    }

    if (socketPlayer.asteroidInteractions === 1) {
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
      const beforeMode = socketPlayer.asteroidMotion?.mode;
      const receivedAt = Date.now();
      const outcome = this.gameEngine.asteroidMotion.acceptFreePose(
        ws,
        {
          epoch: command.motionEpoch,
          sequence: command.motionSequence,
          position: update.position,
          velocity: update.velocity,
          angle: update.angle,
          thrusting: update.thrusting,
        },
        receivedAt
      );
      this.logMotionRejection(
        ws,
        'update',
        outcome,
        receivedAt,
        command.motionEpoch,
        command.motionSequence
      );
      if (outcome.ok && beforeMode === 'handoff') {
        this.logMotionTransition(
          ws,
          'motion_handoff_acknowledged',
          receivedAt,
          command.motionSequence
        );
      }
      return;
    }

    // Hold the server spawn point until the client echoes a nearby transform.
    // The instant respawn clears dead/exploding flags, a stale death-pose
    // update would otherwise teleport the ship back onto the wall/roid.
    if (existing && isStaleDeathPose(existing.respawnAnchor, update.position)) {
      return;
    }
    if (existing?.respawnAnchor && update.position) {
      delete existing.respawnAnchor;
    }

    const player = this.gameEngine.updatePlayer(id, update);
    if (!player) {
      return; // Player not found
    }

    // Projectiles travel through the validated shoot path; no production
    // receiver consumes a movement packet's legacy lasers array.
    this.broadcaster.broadcastPlayerUpdate(id, update);
  }

  private handlePlayerShoot(ws: WebSocket, command: CommandOf<'shoot'>): void {
    const { id, laserStart, laserDirection } = command;
    logger.debug('DEBUG: Server received shoot message', { id, laserStart, laserDirection });

    const shooter = this.gameEngine.getPlayerBySocket(ws);
    if (shooter?.type !== 'human' || shooter.id !== id) {
      return;
    }

    const laser = this.gameEngine.spawnHumanLaser(shooter.id, laserStart, laserDirection);
    if (!laser) {
      return;
    }

    this.broadcaster.broadcastPlayerShoot(shooter.id, laserStart, laserDirection, laser.id);
    this.broadcastAppliedAsteroidHits(this.gameEngine.resolveSpawnedLaserHits(laser.id));
  }

  private handleShield(ws: WebSocket, command: CommandOf<'shield'>): void {
    const { id, active } = command;
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== id) {
      return;
    }
    this.gameEngine.requestShield(id, active);
    this.broadcaster.broadcastGameState();
  }

  private handleChat(ws: WebSocket, command: CommandOf<'chat'>): void {
    const { id, message } = command;
    const player = this.gameEngine.getPlayerBySocket(ws);
    if (player?.type === 'human' && player.id === id) {
      this.broadcaster.broadcastChatMessage(player.id, player.name, message);
    }
  }

  private getReporterId(ws: WebSocket): string | undefined {
    return this.gameEngine.entityManager.getHumanBySocket(ws)?.id;
  }

  private emitShipDamage(
    targetId: string,
    attackerId: string,
    damage: number,
    healthBefore: number | undefined,
    source?: CombatDamageSource
  ): void {
    const outcome = this.gameEngine.handleShipDamage(targetId, attackerId, damage, source);
    if (!outcome.applied || !outcome.entity) {
      return;
    }
    const healthDropped = healthBefore !== undefined && outcome.entity.health < healthBefore;
    if (!outcome.isDestroyed && !healthDropped) {
      if (outcome.entity.shieldActive || outcome.entity.shieldTimer > 0) {
        this.broadcaster.broadcastGameState();
      }
      return;
    }
    this.broadcaster.broadcastCombatResult({
      targetId,
      attackerId,
      damage,
      remainingHealth: outcome.entity.health,
      remainingLives: outcome.entity.lives,
      isDestroyed: outcome.isDestroyed,
      targetType: outcome.entity.type,
      targetName: outcome.entity.name,
      ...(outcome.isDestroyed
        ? (() => {
            const attacker = this.gameEngine.entityManager.getEntity(attackerId);
            return attacker
              ? { awardedScore: { playerId: attackerId, score: attacker.score } }
              : {};
          })()
        : {}),
    });
  }

  private handleLaserDamage(ws: WebSocket, command: CommandOf<'laserDamage'>): void {
    if (this.gameEngine.usesAuthoritativeProjectiles()) {
      return;
    }
    const { targetPlayerId, attackerId } = command;

    const reporterId = this.getReporterId(ws);
    if (!reporterId || !isAllowedLaserReporter(reporterId, attackerId, targetPlayerId)) {
      return;
    }

    const bot = this.gameEngine.getBot(targetPlayerId);
    if (bot?.type === 'bot') {
      if (
        reporterId !== attackerId ||
        !this.gameEngine.consumeHumanLaserNearTarget(
          reporterId,
          bot.position,
          radiusFromMass(bot.mass ?? GROWTH.BASE_MASS)
        )
      ) {
        return;
      }
      this.emitShipDamage(bot.id, reporterId, DAMAGE.LASER_HIT, bot.health, 'laser');
      return;
    }

    const damage = clampLaserDamage(command.damage);
    if (damage <= 0) {
      return;
    }

    const before = this.gameEngine.entityManager.getEntity(targetPlayerId);
    this.emitShipDamage(targetPlayerId, attackerId, damage, before?.health, 'laser');
  }

  private handleCollisionDamage(ws: WebSocket, command: CommandOf<'collisionDamage'>): void {
    const { targetPlayerId, attackerId } = command;
    logger.debug('handleCollisionDamage', { targetPlayerId });

    // Ship↔asteroid and ship↔ship are resolved in the server game loop.
    // Satellite hull damage stays on satelliteDamage, not this leftover path.
    if (!isClientOwnedCollisionAttacker(attackerId)) {
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || reporterId !== targetPlayerId) {
      return;
    }

    const before = this.gameEngine.getPlayer(targetPlayerId);
    this.emitShipDamage(targetPlayerId, 'boundary', DAMAGE.BOUNDARY_COLLISION, before?.health);
  }

  private handleSatelliteDamage(ws: WebSocket, command: CommandOf<'satelliteDamage'>): void {
    if (this.gameEngine.usesAuthoritativeProjectiles()) {
      return;
    }
    const { satelliteId, attackerId, laserPosition } = command;

    const reporterId = this.getReporterId(ws);
    if (!reporterId || reporterId !== attackerId) {
      return;
    }
    if (!this.gameEngine.consumeHumanLaserNearSatellite(reporterId, satelliteId, laserPosition)) {
      return;
    }

    const isDestroyed = this.gameEngine.handleSatelliteDamage(
      satelliteId,
      reporterId,
      DAMAGE.LASER_HIT
    );
    this.broadcaster.broadcastGameState();

    if (isDestroyed) {
      const attacker = this.gameEngine.getPlayer(reporterId);
      if (attacker) {
        this.broadcaster.broadcastScoreUpdate(reporterId, attacker.score);
      }
    }
  }

  private handleSatellitePickupCollected(
    ws: WebSocket,
    command: CommandOf<'satellitePickupCollected'>
  ): void {
    const { pickupId, claimedPlayerId } = command;

    const reporterId = this.getReporterId(ws);
    if (!reporterId || (claimedPlayerId !== undefined && claimedPlayerId !== reporterId)) {
      return;
    }
    const result = this.gameEngine.handleSatellitePickupCollected(pickupId, reporterId);
    if (!result.success || !result.pickup) {
      return;
    }

    const player = this.gameEngine.getPlayer(reporterId);
    if (!player) {
      return;
    }
    this.broadcaster.broadcastScoreUpdate(reporterId, player.score);
    this.broadcaster.broadcastSatellitePickupCollected({
      pickupId: result.pickup.id,
      playerId: reporterId,
      playerName: player.name,
      pickupName: result.pickup.name,
      scoreBonus: SATELLITE_PICKUP.SCORE_BONUS,
      shieldFrames: SATELLITE_PICKUP.SHIELD_FRAMES,
    });
    this.broadcaster.broadcastGameState();
  }

  private handleBotDamage(ws: WebSocket, command: CommandOf<'botDamage'>): void {
    if (this.gameEngine.usesAuthoritativeProjectiles()) {
      return;
    }
    const { botId, attackerId } = command;

    if (isServerOwnedRamAttacker(attackerId)) {
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || reporterId !== attackerId) {
      return;
    }

    const bot = this.gameEngine.getBot(botId);
    if (
      !bot ||
      !this.gameEngine.consumeHumanLaserNearTarget(
        reporterId,
        bot.position,
        radiusFromMass(bot.mass ?? GROWTH.BASE_MASS)
      )
    ) {
      return;
    }

    this.emitShipDamage(bot.id, reporterId, DAMAGE.LASER_HIT, bot.health, 'laser');
  }

  private handleUseAbility(ws: WebSocket, command: CommandOf<'useAbility'>): void {
    const playerId = command.id;
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== playerId) {
      return;
    }
    // The join payload selects the kit. An ability request may echo that
    // selection for compatibility, but it cannot change authoritative ship
    // stats after the socket has joined.
    if (command.kitId !== undefined && command.kitId !== socketPlayer.kitId) {
      return;
    }
    const activated = this.gameEngine.useAbility(playerId, command.kitId, command.latchView);
    if (!activated) {
      return;
    }
    const entity = this.gameEngine.getPlayer(playerId) ?? this.gameEngine.getBot(playerId);
    if (!entity) {
      return;
    }
    this.broadcaster.broadcastToAll({
      type: 'abilityUsed',
      data: {
        id: playerId,
        kitId: entity.kitId,
        ...(command.abilityId !== undefined ? { abilityId: command.abilityId } : {}),
        harpoonTimer: entity.harpoonTimer,
        ...(entity.harpoonTargetId !== undefined
          ? { harpoonTargetId: entity.harpoonTargetId }
          : {}),
        ...(entity.harpoonLatchPos !== undefined
          ? { harpoonLatchPos: entity.harpoonLatchPos }
          : {}),
      },
      timestamp: Date.now(),
    });
    this.broadcaster.broadcastGameState();
  }

  private handleAsteroidDamage(ws: WebSocket, command: CommandOf<'asteroidDamage'>): void {
    if (this.gameEngine.usesAuthoritativeProjectiles()) {
      return;
    }
    const { asteroidId, playerId } = command;

    const asteroid = this.gameEngine.getAsteroid(asteroidId);
    if (!asteroid?.isCollabTarget) {
      return;
    }

    const shooterId = this.resolveAsteroidShooter(ws, playerId, asteroid.id);
    if (!shooterId) {
      return;
    }

    const shooter = this.gameEngine.getPlayer(shooterId);
    const consumed =
      shooter?.type === 'bot'
        ? this.gameEngine.consumeActiveBotLaserNearAsteroid(shooterId, asteroid.id)
        : shooter?.type === 'human' &&
          this.gameEngine.consumeHumanLaserNearTarget(shooterId, asteroid.position, asteroid.size);
    if (!consumed) {
      return;
    }

    // Consume before applying the validated chip: a lethal hit removes the
    // asteroid needed to match this projectile to its target.
    const result = this.gameEngine.handleAsteroidDamage(asteroid.id, shooterId);

    if (result.destroyed) {
      const player = this.gameEngine.getPlayer(shooterId);
      if (player) {
        this.broadcaster.broadcastScoreUpdate(shooterId, player.score);
      }
      this.broadcaster.broadcastAsteroidDestruction(asteroid.id);
      if (result.newAsteroids.length > 0) {
        this.broadcaster.broadcastAsteroidCreation(result.newAsteroids);
      }
      return;
    }

    if (result.asteroid) {
      this.broadcaster.broadcastAsteroidUpdate(asteroid.id, {
        health: result.asteroid.health,
        maxHealth: result.asteroid.maxHealth,
      });
    }
  }

  private handleAsteroidDestroyed(ws: WebSocket, command: CommandOf<'asteroidDestroyed'>): void {
    if (this.gameEngine.usesAuthoritativeProjectiles()) {
      return;
    }
    const { asteroidId, playerId, laserPosition } = command;

    const asteroid = this.gameEngine.getAsteroid(asteroidId);
    if (!asteroid) {
      return;
    }
    if (asteroid.isCollabTarget || asteroid.phenomenon) {
      return;
    }

    const shooterId = this.resolveAsteroidShooter(ws, playerId, asteroid.id);
    if (!shooterId) {
      return;
    }

    // Client reports are hints about a shot that the server already tracks.
    // Consume exactly the owning projectile before applying the hit. The
    // server laser tick marks its own laser in resolveLaserAgainstAsteroids;
    // applying this report must never search for and consume another shot.
    const shooter = this.gameEngine.getPlayer(shooterId);
    const projectileConsumed =
      shooter?.type === 'bot'
        ? this.gameEngine.consumeActiveBotLaserNearAsteroid(shooter.id, asteroid.id, laserPosition)
        : shooter?.type === 'human'
          ? this.gameEngine.consumeHumanLaserNearTarget(
              shooter.id,
              asteroid.position,
              asteroid.size,
              laserPosition
            )
          : false;
    if (!projectileConsumed) {
      return;
    }

    this.broadcastAppliedAsteroidHits([
      this.gameEngine.applyLaserAsteroidHit(asteroid.id, shooterId, laserPosition, 'laser'),
    ]);
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
        this.broadcaster.broadcastScoreUpdate(hit.playerId, scorer.score);
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

  private handleLootExplode(ws: WebSocket, command: CommandOf<'lootExplode'>): void {
    if (this.gameEngine.usesAuthoritativeProjectiles()) {
      return;
    }
    const { id, lootId, claimedPlayerId, invalidPlayerClaim } = command;

    // Every observer can report the same bot laser/drop collision. Once the
    // first valid report removes the authoritative drop, later reports are
    // harmless duplicate acknowledgements. Check the live target before
    // resolving shooter identity so a consumed drop does not produce a false
    // "Unknown shooter" error, while live forged claims still go through the
    // normal ownership/projectile proof below.
    if (!this.gameEngine.getLoot().some((loot) => loot.id === lootId)) {
      return;
    }

    if (invalidPlayerClaim) {
      this.broadcaster.sendError(ws, 'Unknown shooter for lootExplode');
      return;
    }

    const shooterId = this.resolveAuxiliaryShooter(ws, claimedPlayerId ?? id, lootId);
    if (!shooterId) {
      this.broadcaster.sendError(ws, 'Unknown shooter for lootExplode');
      return;
    }

    const result = this.gameEngine.handleLootExplode(shooterId, lootId);
    if (!result.success || !result.origin) {
      return;
    }

    this.broadcaster.broadcastLootExploded({
      lootId,
      position: result.origin,
      radius: LOOT_BLAST.RADIUS,
      shooterId,
    });

    for (const asteroidId of result.pushedAsteroidIds) {
      const asteroid = this.gameEngine.getAsteroid(asteroidId);
      if (asteroid) {
        this.broadcaster.broadcastAsteroidUpdate(asteroidId, { velocity: asteroid.velocity });
      }
    }
  }

  /**
   * Human asteroid reports bind to their socket. Bot reports are accepted only
   * when the server has the claimed bot's projectile in flight near the same
   * asteroid; no client-provided bot identity is authoritative by itself.
   */
  private resolveAsteroidShooter(
    ws: WebSocket,
    claimedId: string,
    asteroidId: string
  ): string | null {
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human') {
      return null;
    }
    if (socketPlayer.id === claimedId) {
      return socketPlayer.id;
    }

    const claimed = this.gameEngine.getPlayer(claimedId);
    if (
      claimed?.type === 'bot' &&
      this.gameEngine.hasActiveBotLaserNearAsteroid(claimed.id, asteroidId)
    ) {
      return claimed.id;
    }

    return null;
  }

  /**
   * Human claims bind to this socket. A bot claim additionally requires a
   * live server projectile at this specific drop, consumed exactly once.
   */
  private resolveAuxiliaryShooter(
    ws: WebSocket,
    claimedId: string | undefined,
    lootId: string
  ): string | null {
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human') {
      return null;
    }
    if (claimedId === undefined || claimedId === socketPlayer.id) {
      return socketPlayer.id;
    }

    const claimed = this.gameEngine.getPlayer(claimedId ?? '');
    if (
      claimed?.type === 'bot' &&
      this.gameEngine.consumeActiveBotLaserNearLoot(claimed.id, lootId)
    ) {
      return claimed.id;
    }
    return null;
  }

  private handleInitAsteroids(ws: WebSocket, command: CommandOf<'initAsteroids'>): void {
    const { id } = command;
    logger.debug('Handling initAsteroids message', { id });

    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== id) {
      return;
    }

    // The active server owns field creation and replenishment. Keep this
    // message as an idempotent resync for reconnecting clients, but do not
    // trust a client-requested count as the source of world state.
    const created = this.gameEngine.ensureAsteroidField();
    if (created.length > 0) {
      this.broadcaster.broadcastAsteroidCreation(created);
      logger.debug('Player received the newly seeded asteroid field', { playerId: id });
      return;
    }

    const existingAsteroids = this.gameEngine.getAllAsteroids();
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

  private handleBotUpdate(ws: WebSocket, command: CommandOf<'botUpdate'>): void {
    const { botId, playerId } = command;

    // For now, only server-owned bots can be updated through this message
    // Client-owned bots should be handled differently
    if (playerId !== 'server') {
      this.broadcaster.sendError(ws, 'Only server-owned bots can be updated through this endpoint');
      return;
    }

    // Update bot through broadcaster (for client-owned bots)
    this.broadcaster.broadcastBotUpdate(botId);
  }

  private handlePing(ws: WebSocket): void {
    this.broadcaster.sendToWebSocket(ws, { type: 'pong', timestamp: Date.now() });
  }

  private logMotionRejection(
    ws: WebSocket,
    commandType: 'asteroidTool' | 'asteroidInput' | 'update',
    outcome: MotionOutcome,
    receivedAt: number,
    receivedEpoch?: number,
    receivedSequence?: number
  ): void {
    if (outcome.ok) {
      return;
    }
    const previous = this.motionRejections.get(ws);
    if (previous && receivedAt - previous.lastLoggedAt < 5000) {
      previous.suppressed += 1;
      return;
    }
    const owner = this.gameEngine.getPlayerBySocket(ws);
    const motion = owner ? this.gameEngine.asteroidMotion.getState(owner.id) : undefined;
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
      ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}),
    });
    this.motionRejections.set(ws, { lastLoggedAt: receivedAt, suppressed: 0 });
  }

  private logSnapshotResync(ws: WebSocket, receivedAt: number): void {
    const previous = this.snapshotResyncLogs.get(ws);
    if (previous && receivedAt - previous.lastLoggedAt < 5000) {
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
    this.snapshotResyncLogs.set(ws, { lastLoggedAt: receivedAt, suppressed: 0 });
  }

  private logMotionTransition(
    ws: WebSocket,
    event: 'motion_latched' | 'motion_action_accepted' | 'motion_handoff_acknowledged',
    observedAt: number,
    sequence: number,
    action?: string
  ): void {
    const owner = this.gameEngine.getPlayerBySocket(ws);
    if (!owner) {
      return;
    }
    const motion = this.gameEngine.asteroidMotion.getState(owner.id);
    logger.info('STATE', event, {
      releaseId: SERVER_RELEASE_ID,
      playerId: owner.id,
      observedAt,
      gameTime: this.gameEngine.getDiagnostics().gameTime,
      sequence,
      ...(action ? { action } : {}),
      ...(motion
        ? { motionEpoch: motion.epoch, motionAck: motion.ack, motionMode: motion.mode }
        : {}),
    });
  }
}
