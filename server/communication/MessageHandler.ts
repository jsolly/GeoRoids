import { WebSocket } from 'ws';
import { GameEngine, type AppliedAsteroidHit } from '../core/GameEngine';
import { GameStateBroadcaster } from '../services/GameStateBroadcaster';
import { ClientLogger } from '../services/ClientLogger';
import { logger } from '../../setup/serverLogger';
import { DAMAGE, SATELLITE_PICKUP } from '../../src/constants';
import {
  clampLaserDamage,
  isAllowedLaserReporter,
  isClientOwnedCollisionAttacker,
  isServerOwnedRamAttacker,
} from '../../shared/combat';
import { LOOT_BLAST } from '../../shared/lootBlast';
import type { CombatDamageSource } from '../../src/entities/ship/shipShield';
import { isStaleDeathPose } from '../core/EntityManager';

const PAYLOAD_PREVIEW_MAX_CHARS = 500;

function boundedPayloadPreview(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= PAYLOAD_PREVIEW_MAX_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, PAYLOAD_PREVIEW_MAX_CHARS)}…`;
}

export class MessageHandler {
  private gameEngine: GameEngine;
  private broadcaster: GameStateBroadcaster;

  constructor(gameEngine: GameEngine, broadcaster: GameStateBroadcaster) {
    this.gameEngine = gameEngine;
    this.broadcaster = broadcaster;
  }

  public handleMessage(message: any, ws: WebSocket): void {
    // Accept both top-level fields and nested data payloads for compatibility
    const type = message.type;
    const payload = typeof message.data === 'object' && message.data !== null ? message.data : {};
    const id = message.id ?? payload.id;
    const name = message.name ?? payload.name;
    const restData = { ...payload, ...message };
    delete (restData as any).type;
    delete (restData as any).id;
    delete (restData as any).name;
    
    if (type === 'join') {
      logger.debug('Handling join message', {
        id,
        name,
        keys: Object.keys(message),
      });
    }

    // Don't delete data field for clientLog and join messages as they need the nested structure
    if (type !== 'clientLog' && type !== 'join') {
      delete (restData as any).data;
    }

    try {
      switch (type) {
        case 'join':
          this.handleJoin(ws, id, name, restData);
          break;

        case 'snapshotResync':
          if (this.gameEngine.getPlayerBySocket(ws)?.type === 'human') {
            this.broadcaster.requestSnapshotKeyframe(ws);
          }
          break;

        case 'useAbility':
          this.handleUseAbility(ws, id, restData);
          break;

        case 'asteroidDamage':
          this.handleAsteroidDamage(ws, restData);
          break;

        case 'update':
          this.handlePlayerUpdate(ws, id, restData);
          break;

        case 'shoot':
          this.handlePlayerShoot(ws, id, restData);
          break;

        case 'shield':
          this.handleShield(ws, id, restData);
          break;

        case 'chat':
          this.handleChat(ws, id, restData);
          break;

        case 'laserDamage':
          this.handleLaserDamage(ws, restData);
          break;

        case 'collisionDamage':
          this.handleCollisionDamage(ws, restData);
          break;

        case 'botDamage':
          this.handleBotDamage(ws, restData);
          break;

        case 'satelliteDamage':
          this.handleSatelliteDamage(ws, restData);
          break;

        case 'satellitePickupCollected':
          this.handleSatellitePickupCollected(ws, restData);
          break;

        case 'asteroidDestroyed':
          this.handleAsteroidDestroyed(ws, restData);
          break;

        case 'lootExplode':
          this.handleLootExplode(ws, id, restData);
          break;

        case 'initAsteroids':
          this.handleInitAsteroids(ws, id, restData);
          break;

        case 'botUpdate':
          this.handleBotUpdate(ws, restData);
          break;

        case 'clientLog':
          this.handleClientLog(restData);
          break;

        case 'ping':
          this.handlePing(ws);
          break;

        default:
          logger.warn(`Unknown message type: ${type}`);
          this.broadcaster.sendError(ws, `Unknown message type: ${type}`);
      }
    } catch (error) {
      logger.error('Error handling message', {
        messageType: type ?? '<missing>',
        messageId: id ?? '<missing>',
        payloadPreview: boundedPayloadPreview(restData),
      }, error);
      this.broadcaster.sendError(ws, 'Internal server error');
    }
  }

  private handleJoin(ws: WebSocket, id: string, name: string, data: any): void {
    logger.debug('Handling join message', { id, name });

    if (!id || !name) {
      logger.warn('❌ Missing player ID or name for join', { id, name });
      this.broadcaster.sendError(ws, 'Missing player ID or name');
      return;
    }

    const validatedPosition = this.gameEngine.validatePosition(data.position);
    const joinPosition = validatedPosition || { x: 0, y: 0 };
    const kitId = data.kitId ?? data.data?.kitId;
    const factionId = data.factionId ?? data.data?.factionId;
    logger.debug('Player join', { id, position: joinPosition, kitId, factionId });

    const player = this.gameEngine.addPlayer(id, name, ws, joinPosition, undefined, kitId, factionId);
    logger.info('✅ Player added to game engine', { id, name, factionId: player.factionId });

    const replacedId = this.gameEngine.consumeReplacedHumanId();
    if (replacedId) {
      this.broadcaster.broadcastPlayerLeft(replacedId);
    }

    const snapshotVersion = this.broadcaster.negotiateSnapshot(ws, data.snapshotVersion ?? data.data?.snapshotVersion);

    // Send confirmation to the joining player
    this.broadcaster.sendToWebSocket(ws, {
      type: 'joined',
      data: {
        id,
        name,
        position: joinPosition,
        color: player.color,
        kitId: player.kitId,
        factionId: player.factionId,
        terrainSeed: this.gameEngine.getTerrainSeed(),
        ...(snapshotVersion ? { snapshotVersion } : {}),
      },
      timestamp: Date.now(),
    });
    logger.debug('📤 Sent joined confirmation', { id, name });

    // Broadcast to all other players
    this.broadcaster.broadcastPlayerJoined(id, name, joinPosition);
    this.broadcaster.broadcastGameState();
    logger.debug('📢 Broadcasted player joined and game state', { id, name });
  }

  private handlePlayerUpdate(ws: WebSocket, id: string, data: any): void {
    if (!id) {
      this.broadcaster.sendError(ws, 'Missing player ID');
      return;
    }
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== id) {
      return;
    }

    // Ignore movement updates while the player is dead, exploding, or waiting to
    // respawn. Otherwise the client's stale position keeps overwriting the
    // server-chosen respawn position, leaving the ship frozen where it died
    // (e.g. stuck outside the boundary at full health).
    const existing = this.gameEngine.getPlayer(id);
    if (existing && (existing.exploding || existing.respawnTimer !== undefined || existing.health <= 0)) {
      return;
    }

    // Hold the server spawn point until the client echoes a nearby transform.
    // The instant respawn clears dead/exploding flags, a stale death-pose
    // update would otherwise teleport the ship back onto the wall/roid.
    if (existing && isStaleDeathPose(existing.respawnAnchor, data.position)) {
      return;
    }
    if (existing?.respawnAnchor && data.position) {
      existing.respawnAnchor = undefined;
    }

    // Server-authoritative fields: the client only mirrors these back from our
    // own broadcasts, so accepting them lets a stale client value clobber the
    // authoritative state (e.g. a freshly-awarded score getting reset to 0).
    const sanitizedData: any = { ...data };
    delete (sanitizedData as any).health;
    delete (sanitizedData as any).maxHealth;
    delete (sanitizedData as any).fuel;
    delete (sanitizedData as any).maxFuel;
    delete (sanitizedData as any).mass;
    delete (sanitizedData as any).score;
    delete (sanitizedData as any).lives;
    delete (sanitizedData as any).respawnTimer;
    delete (sanitizedData as any).spawnProtectionTimer;
    delete (sanitizedData as any).kitId;
    delete (sanitizedData as any).factionId;
    delete (sanitizedData as any).faction;
    delete (sanitizedData as any).color;
    delete (sanitizedData as any).abilityCooldownFrames;
    delete (sanitizedData as any).abilityActiveFrames;
    delete (sanitizedData as any).shieldTimer;
    delete (sanitizedData as any).harpoonTimer;
    delete (sanitizedData as any).harpoonTargetId;
    delete (sanitizedData as any).shieldActive;
    delete (sanitizedData as any).shieldTime;
    delete (sanitizedData as any).shieldCooldown;
    delete (sanitizedData as any).shieldFlashTime;

    // Normalize client fields to server schema
    if (sanitizedData.angle !== undefined && sanitizedData.rotation === undefined) {
      sanitizedData.rotation = sanitizedData.angle;
    }
    if (sanitizedData.a !== undefined && sanitizedData.angularVelocity === undefined) {
      sanitizedData.angularVelocity = sanitizedData.a;
    }

    const player = this.gameEngine.updatePlayer(id, sanitizedData);
    if (!player) {
      return; // Player not found
    }

    // Include laser data if provided
    const updateData: any = { ...sanitizedData };
    if (sanitizedData.lasers !== undefined) {
      updateData.lasers = sanitizedData.lasers;
    }

    this.broadcaster.broadcastPlayerUpdate(id, updateData);
  }

  private handlePlayerShoot(ws: WebSocket, id: string, data: any): void {
    logger.debug('DEBUG: Server received shoot message', { id, data });
    if (!id) {
      this.broadcaster.sendError(ws, 'Missing player ID for shoot');
      return;
    }

    const shooter = this.gameEngine.getPlayerBySocket(ws);
    if (shooter?.type !== 'human' || shooter.id !== id) {
      return;
    }

    const laser = this.gameEngine.spawnHumanLaser(shooter.id, data.laserStart, data.laserDirection);
    if (!laser) {
      return;
    }

    this.broadcaster.broadcastPlayerShoot(shooter.id, data.laserStart, data.laserDirection);
    this.broadcastAppliedAsteroidHits(this.gameEngine.resolveSpawnedLaserHits());
  }

  private handleShield(ws: WebSocket, id: string, data: any): void {
    if (!id) {
      this.broadcaster.sendError(ws, 'Missing player ID for shield');
      return;
    }
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== id) {
      return;
    }
    if (typeof data.active !== 'boolean') {
      this.broadcaster.sendError(ws, 'Missing active flag for shield');
      return;
    }

    this.gameEngine.requestShield(id, data.active);
    this.broadcaster.broadcastGameState();
  }

  private handleChat(ws: WebSocket, id: string, data: any): void {
    if (!id || !data.message) {
      this.broadcaster.sendError(ws, 'Missing player ID or message');
      return;
    }

    const player = this.gameEngine.getPlayer(id);
    if (player) {
      this.broadcaster.broadcastChatMessage(id, player.name, data.message);
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
    const healthDropped =
      healthBefore !== undefined && outcome.entity.health < healthBefore;
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
      awardedScore: outcome.isDestroyed
        ? (() => {
            const attacker = this.gameEngine.entityManager.getEntity(attackerId);
            return attacker ? { playerId: attackerId, score: attacker.score } : undefined;
          })()
        : undefined,
    });
  }

  private handleLaserDamage(ws: WebSocket, data: any): void {
    if (!data.targetPlayerId || !data.attackerId || data.damage === undefined) {
      this.broadcaster.sendError(ws, 'Missing required fields for laserDamage');
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || !isAllowedLaserReporter(reporterId, data.attackerId, data.targetPlayerId)) {
      return;
    }

    const damage = clampLaserDamage(data.damage);
    if (damage <= 0) {
      return;
    }

    const before = this.gameEngine.entityManager.getEntity(data.targetPlayerId);
    this.emitShipDamage(data.targetPlayerId, data.attackerId, damage, before?.health, 'laser');
  }

  private handleCollisionDamage(ws: WebSocket, data: any): void {
    logger.debug('handleCollisionDamage', { targetPlayerId: data?.targetPlayerId });
    if (!data.targetPlayerId || !data.attackerId || data.damage === undefined) {
      this.broadcaster.sendError(ws, 'Missing required fields for collisionDamage');
      return;
    }

    // Ship↔asteroid and ship↔ship are resolved in the server game loop.
    // Satellite hull damage stays on satelliteDamage, not this leftover path.
    if (!isClientOwnedCollisionAttacker(data.attackerId)) {
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || reporterId !== data.targetPlayerId) {
      return;
    }

    const before = this.gameEngine.getPlayer(data.targetPlayerId);
    this.emitShipDamage(
      data.targetPlayerId,
      'boundary',
      DAMAGE.BOUNDARY_COLLISION,
      before?.health
    );
  }

  private handleSatelliteDamage(ws: WebSocket, data: any): void {
    if (
      typeof data.satelliteId !== 'string' ||
      data.satelliteId.length === 0 ||
      typeof data.attackerId !== 'string' ||
      data.attackerId.length === 0
    ) {
      this.broadcaster.sendError(ws, 'Missing required fields for satelliteDamage');
      return;
    }

    const reporterId = this.getReporterId(ws);
    const laserPosition = this.readFinitePosition(data.laserPosition);
    if (!reporterId || reporterId !== data.attackerId || !laserPosition) {
      return;
    }
    if (!this.gameEngine.consumeHumanLaserNearSatellite(reporterId, data.satelliteId, laserPosition)) {
      return;
    }

    const isDestroyed = this.gameEngine.handleSatelliteDamage(
      data.satelliteId,
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

  private handleSatellitePickupCollected(ws: WebSocket, data: any): void {
    if (typeof data.pickupId !== 'string' || data.pickupId.length === 0) {
      this.broadcaster.sendError(ws, 'Missing pickup ID for satellitePickupCollected');
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || (data.playerId !== undefined && data.playerId !== reporterId)) {
      return;
    }
    const result = this.gameEngine.handleSatellitePickupCollected(data.pickupId, reporterId);
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

  private handleBotDamage(ws: WebSocket, data: any): void {
    if (!data.botId || !data.attackerId || data.damage === undefined) {
      this.broadcaster.sendError(ws, 'Missing required fields for botDamage');
      return;
    }

    if (isServerOwnedRamAttacker(data.attackerId)) {
      return;
    }

    const reporterId = this.getReporterId(ws);
    if (!reporterId || (reporterId !== data.attackerId && reporterId !== data.botId)) {
      return;
    }

    const before = this.gameEngine.getBot(data.botId);
    this.emitShipDamage(data.botId, data.attackerId, data.damage, before?.health, 'laser');
  }

  private handleUseAbility(ws: WebSocket, id: string, data: any): void {
    const playerId = id || data.id;
    if (!playerId) {
      this.broadcaster.sendError(ws, 'Missing player ID for useAbility');
      return;
    }
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human' || socketPlayer.id !== playerId) {
      return;
    }
    // The join payload selects the kit. An ability request may echo that
    // selection for compatibility, but it cannot change authoritative ship
    // stats after the socket has joined.
    if (data.kitId !== undefined && data.kitId !== socketPlayer.kitId) {
      return;
    }
    const canvasWidth = Number(data.canvasWidth);
    const canvasHeight = Number(data.canvasHeight);
    const playfieldScale = Number(data.playfieldScale);
    const activated = this.gameEngine.useAbility(playerId, data.kitId, {
      playfieldScale:
        Number.isFinite(playfieldScale) && playfieldScale > 0 ? playfieldScale : undefined,
      canvas:
        Number.isFinite(canvasWidth) &&
        Number.isFinite(canvasHeight) &&
        canvasWidth > 0 &&
        canvasHeight > 0
          ? { width: canvasWidth, height: canvasHeight }
          : undefined,
    });
    if (!activated) {
      return;
    }
    const entity = this.gameEngine.getPlayer(playerId) ?? this.gameEngine.getBot(playerId);
    this.broadcaster.broadcastToAll({
      type: 'abilityUsed',
      data: {
        id: playerId,
        kitId: entity?.kitId,
        abilityId: data.abilityId,
        harpoonTimer: entity?.harpoonTimer,
        harpoonTargetId: entity?.harpoonTargetId,
        harpoonLatchPos: entity?.harpoonLatchPos,
      },
      timestamp: Date.now(),
    });
    this.broadcaster.broadcastGameState();
  }

  private handleAsteroidDamage(ws: WebSocket, data: any): void {
    if (
      typeof data.asteroidId !== 'string' ||
      data.asteroidId.length === 0 ||
      typeof data.playerId !== 'string' ||
      data.playerId.length === 0 ||
      typeof data.damage !== 'number' ||
      !Number.isFinite(data.damage) ||
      data.damage <= 0
    ) {
      this.broadcaster.sendError(ws, 'Missing required fields for asteroidDamage');
      return;
    }

    const asteroid = this.gameEngine.getAsteroid(data.asteroidId);
    if (!asteroid?.isCollabTarget) {
      return;
    }

    const shooterId = this.resolveAsteroidShooter(ws, data.playerId, asteroid.id);
    if (!shooterId) {
      return;
    }

    if (
      this.gameEngine.getPlayer(shooterId)?.type === 'bot' &&
      !this.gameEngine.consumeActiveBotLaserNearAsteroid(shooterId, asteroid.id)
    ) {
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

  private handleAsteroidDestroyed(ws: WebSocket, data: any): void {
    if (
      typeof data.asteroidId !== 'string' ||
      data.asteroidId.length === 0 ||
      typeof data.playerId !== 'string' ||
      data.playerId.length === 0
    ) {
      this.broadcaster.sendError(ws, 'Missing required fields for asteroidDestroyed');
      return;
    }

    if (data.cause === 'collision') {
      this.broadcaster.sendError(ws, 'Server owns asteroid collision reports');
      return;
    }
    if (data.cause !== undefined && data.cause !== 'laser') {
      this.broadcaster.sendError(ws, 'Invalid cause for asteroidDestroyed');
      return;
    }

    const laserPosition = this.readFinitePosition(data.laserPosition);
    if (!laserPosition) {
      this.broadcaster.sendError(ws, 'Missing finite laserPosition for asteroidDestroyed');
      return;
    }

    const asteroid = this.gameEngine.getAsteroid(data.asteroidId);
    if (!asteroid) {
      return;
    }
    if (asteroid.isCollabTarget) {
      return;
    }

    const shooterId = this.resolveAsteroidShooter(ws, data.playerId, asteroid.id);
    if (!shooterId) {
      return;
    }

    this.broadcastAppliedAsteroidHits([
      this.gameEngine.applyLaserAsteroidHit(
        asteroid.id,
        shooterId,
        laserPosition,
        'laser'
      ),
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

      this.broadcaster.broadcastAsteroidDestruction(hit.asteroidId, {
        collabSplit: hit.split,
        origin: hit.origin,
      });

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

  private handleLootExplode(ws: WebSocket, id: string, data: any): void {
    const lootId = data.lootId;
    if (typeof lootId !== 'string' || lootId.length === 0) {
      this.broadcaster.sendError(ws, 'Missing loot ID for lootExplode');
      return;
    }

    const shooterId = this.resolveAuxiliaryShooter(ws, data.playerId ?? id, lootId);
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
   * Client auxiliary events can only act as the human attached to this socket.
   * Server-owned bots may still use GameEngine.handleLootExplode directly;
   * their IDs are never authorized by a client payload.
   */
  private resolveAuxiliaryShooter(
    ws: WebSocket,
    claimedId: unknown,
    lootId: string
  ): string | null {
    const socketPlayer = this.gameEngine.getPlayerBySocket(ws);
    if (socketPlayer?.type !== 'human') {
      return null;
    }
    if (claimedId === undefined || claimedId === socketPlayer.id) {
      return socketPlayer.id;
    }

    const claimed = this.gameEngine.getPlayer(typeof claimedId === 'string' ? claimedId : '');
    if (
      claimed?.type === 'bot' &&
      this.gameEngine.consumeActiveBotLaserNearLoot(claimed.id, lootId)
    ) {
      return claimed.id;
    }
    return null;
  }

  private readFinitePosition(value: unknown): { x: number; y: number } | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const position = value as { x?: unknown; y?: unknown };
    if (
      typeof position.x !== 'number' ||
      !Number.isFinite(position.x) ||
      typeof position.y !== 'number' ||
      !Number.isFinite(position.y)
    ) {
      return null;
    }
    return { x: position.x, y: position.y };
  }

  private handleInitAsteroids(ws: WebSocket, id: string, _data: any): void {
    logger.debug('Handling initAsteroids message', { id });
    if (!id) {
      this.broadcaster.sendError(ws, 'Missing player ID for initAsteroids');
      return;
    }

    // The active server owns field creation and replenishment. Keep this
    // message as an idempotent resync for reconnecting clients, but do not
    // trust a client-requested count as the source of world state.
    const created = this.gameEngine.ensureAsteroidField();
    if (created.length > 0) {
      this.broadcaster.broadcastAsteroidCreation(created);
      logger.debug(`Player ${id} received the newly seeded asteroid field`);
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
    logger.debug(
      `Player ${id} requested asteroid initialization - sent existing ${existingAsteroids.length} asteroids`
    );
  }

  private handleBotUpdate(ws: WebSocket, data: any): void {
    if (!data.botId || !data.playerId) {
      this.broadcaster.sendError(ws, 'Missing bot ID or player ID for botUpdate');
      return;
    }

    // For now, only server-owned bots can be updated through this message
    // Client-owned bots should be handled differently
    if (data.playerId !== 'server') {
      this.broadcaster.sendError(ws, 'Only server-owned bots can be updated through this endpoint');
      return;
    }

    // Update bot through broadcaster (for client-owned bots)
    this.broadcaster.broadcastBotUpdate(data.botId);
  }

  private handleClientLog(data: any): void {
    ClientLogger.logClientMessage(data);
  }

  private handlePing(ws: WebSocket): void {
    this.broadcaster.sendToWebSocket(ws, { type: 'pong', timestamp: Date.now() });
  }
}
