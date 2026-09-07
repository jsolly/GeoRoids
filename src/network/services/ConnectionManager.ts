import type {
  AsteroidData,
  AsteroidDestroyEvent,
  AsteroidTaggedEvent,
  LootData,
  PlayerJoin,
  PlayerLeave,
  PlayerUpdate,
  Position,
  SatellitePickupCollected,
  SatelliteShoot,
  ServerGameState,
  ShockwaveEvent,
  Velocity,
} from '../../../shared-types';
import { playLaserSound } from '../../audio/gameSounds';
import { PALETTE, ROID, SHIP } from '../../constants';
import { entityFactory } from '../../entities/EntityFactory';
import { LootField } from '../../entities/loot/LootField';
import type { Player } from '../../entities/player/Player';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { shouldApplyRemoteShoot } from '../../entities/player/remoteLasers';
import { SatelliteManager } from '../../entities/satellite/SatelliteManager';
import { SatellitePickupManager } from '../../entities/satellitePickup/SatellitePickupManager';
import { setHoldEmptyHarpoonField } from '../../entities/ship/harpoonField';
import { applyShipKitToShip } from '../../entities/ship/shipKits';
import { shouldApplyDamagedHealth } from '../../entities/ship/shipUtils';
import { applyTerrainSeed } from '../../physics/terrain/terrainSession';
import { getSelectedShipKitId } from '../../ui/shipKitSelect';
import { describeDeathCause } from '../../utils/deathCause';
import { logger } from '../../utils/Logger';
import type { ClientMessage, ServerMessage } from '../types';
import {
  applyAsteroidFieldPartition,
  asteroidHasSpawnPose,
  createAsteroidFieldSyncScratch,
  notifyAsteroidCreated,
  notifyAsteroidDestroyed,
  notifyAsteroidTagged,
  notifyAsteroidUpdated,
  partitionAsteroidSnapshot,
  shouldPreserveSeenAsteroidsOnJoin,
} from './asteroidFieldSync';
import { readOrCreateClientId, replaceStoredClientId } from './clientIdentity';
import {
  CONNECTION_STALE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  isConnectionStale,
} from './connectionHealth';
import { nextReconnectDelayMs } from './connectionReconnect';
import { PlayerListCache } from './playerListCache';
import {
  bindPageHideDisconnect,
  fillSnapshotEntityIds,
  isLocalGameEntity,
  pruneDuplicateOwnRemotes,
  pruneStaleRemotePlayers,
} from './playerPresence';

export interface ConnectionState {
  isConnected: boolean;
  socket: WebSocket | null;
}

export class ConnectionManager {
  private static instance: ConnectionManager;
  private state: ConnectionState;

  private clientId: string;
  private localPlayerName: string = '';
  private localPlayerId: string = '';
  private allPlayers: Map<string, Player> = new Map();
  private seenAsteroidIds: Set<string> = new Set(); // Track asteroids we've already seen
  private hasInitializedAsteroidsForConnection = false;
  private readonly playerListCache = new PlayerListCache<Player>();
  private readonly snapshotEntityIds = new Set<string>();
  private readonly asteroidScratch = createAsteroidFieldSyncScratch();
  private readonly pingPayload = { type: 'ping', timestamp: 0 };
  private readonly updateEnvelope: ClientMessage = {
    type: 'update',
    data: {} as PlayerUpdate,
    timestamp: 0,
  };

  // Heartbeat / half-open-socket detection (see connectionHealth.ts).
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerMessageAt = 0;

  // Unexpected close retries. Intentional disconnect() / pagehide do not retry.
  private userRequestedDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnectedOnce = false;
  private connectPromise: Promise<void> | null = null;

  private constructor() {
    this.state = {
      isConnected: false,
      socket: null,
    };
    this.clientId = readOrCreateClientId(
      typeof sessionStorage === 'undefined' ? null : sessionStorage
    );
    // Tab close / bfcache must tear the socket down so the server drops us
    // and other clients can prune this player from their leaderboard.
    bindPageHideDisconnect(() => this.disconnect());
  }

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  getSocket(): WebSocket | null {
    return this.state.socket;
  }

  getClientId(): string {
    return this.clientId;
  }

  isConnected(): boolean {
    return this.state.isConnected;
  }

  async connect(): Promise<void> {
    if (this.state.isConnected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.userRequestedDisconnect = false;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private openSocket(): Promise<void> {
    if (this.state.isConnected || this.state.socket) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        const computedUrl =
          typeof window !== 'undefined'
            ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
            : 'ws://localhost:3001/ws';

        const wsUrl = import.meta.env.VITE_WEBSOCKET_URL || computedUrl;
        logger.debug('NETWORK', 'Connecting to WebSocket', { url: wsUrl });
        this.state.socket = new WebSocket(wsUrl);

        this.state.socket.onopen = (): void => {
          const wasReconnect = this.hasConnectedOnce;
          this.state.isConnected = true;
          this.lastServerMessageAt = Date.now();
          this.reconnectAttempt = 0;
          this.startHeartbeat();
          this.hasConnectedOnce = true;
          logger.info('NETWORK', wasReconnect ? 'Reconnected to server' : 'Connected to server');
          window.dispatchEvent(
            new CustomEvent(wasReconnect ? 'networkReconnected' : 'networkConnected')
          );
          resolve();
        };

        this.state.socket.onerror = (): void => {
          logger.error('NETWORK', 'WebSocket connection error');
          reject(new Error('WebSocket connection failed'));
        };

        this.state.socket.onclose = (): void => {
          this.state.isConnected = false;
          this.state.socket = null;
          this.stopHeartbeat();
          // A reconnect must perform the asteroid handshake again. Keep the
          // cached belt for warm rejoin rendering, but do not treat it as
          // proof that the server process still owns the same field.
          this.hasInitializedAsteroidsForConnection = false;
          // Keep the last belt + latch list. Wiping here is why KeyE during
          // a Reconnecting banner found zero rocks after #485.
          setHoldEmptyHarpoonField(true);
          logger.warn('NETWORK', 'WebSocket connection closed');
          if (this.userRequestedDisconnect) {
            window.dispatchEvent(
              new CustomEvent('networkDisconnected', {
                detail: { reason: 'Connection closed' },
              })
            );
            return;
          }
          // First-connect failure is fatal for startGame; do not retry there.
          if (!this.hasConnectedOnce) {
            return;
          }
          this.scheduleReconnect();
        };

        this.state.socket.onmessage = (event: MessageEvent): void => {
          // Any inbound traffic (game state, pong, etc.) proves the link is alive.
          this.lastServerMessageAt = Date.now();
          try {
            const message: ServerMessage = JSON.parse(event.data);
            this.handleServerMessage(message);
          } catch (error) {
            logger.error(
              'NETWORK',
              'Failed to parse server message',
              error instanceof Error ? error : new Error(String(error))
            );
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(options?: { newSession?: boolean }): void {
    this.userRequestedDisconnect = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    const socket = this.state.socket;
    if (socket) {
      // Drop handlers first so game-over disconnect does not re-enter via onclose.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    this.state.isConnected = false;
    this.state.socket = null;
    this.allPlayers.clear();
    this.playerListCache.invalidate();
    this.seenAsteroidIds.clear();
    this.hasInitializedAsteroidsForConnection = false;
    LootField.getInstance().clear();
    SatelliteManager.getInstance().clear();
    SatellitePickupManager.getInstance().clear();
    this.localPlayerId = '';
    // pagehide / unexpected close keep the stored id (#467). Game-over Start
    // mints a new one so we do not rejoin a 0-life ship.
    this.hasConnectedOnce = false;
    if (options?.newSession) {
      this.clientId = replaceStoredClientId(
        typeof sessionStorage === 'undefined' ? null : sessionStorage
      );
    }
  }

  private describeAttacker(attackerId: string): string {
    return describeDeathCause(attackerId, (id) => this.allPlayers.get(id)?.name);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.userRequestedDisconnect || this.reconnectTimer !== null) {
      return;
    }
    const delay = nextReconnectDelayMs(this.reconnectAttempt);
    if (delay === null) {
      window.dispatchEvent(
        new CustomEvent('networkDisconnected', {
          detail: { reason: 'Reconnect exhausted' },
        })
      );
      window.dispatchEvent(
        new CustomEvent('networkPermanentlyDisconnected', {
          detail: { reason: 'Reconnect exhausted' },
        })
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent('networkReconnecting', {
        detail: { attempt: this.reconnectAttempt + 1, delayMs: delay },
      })
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      void this.connect().catch(() => {
        if (!this.state.socket && !this.userRequestedDisconnect) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Periodic liveness check. Pings the server (which replies with `pong`,
   * refreshing lastServerMessageAt) and, if nothing has been heard within the
   * stale timeout, tears the socket down locally so the disconnect surfaces in
   * the UI — even for half-open/zombie sockets the browser hasn't reported.
   */
  private checkHeartbeat(): void {
    const socket = this.state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      this.pingPayload.timestamp = Date.now();
      socket.send(JSON.stringify(this.pingPayload));
    } catch {
      // A throwing send on an OPEN socket means it is broken; stale check closes it.
    }

    if (isConnectionStale(this.lastServerMessageAt, Date.now())) {
      logger.warn('NETWORK', 'No server traffic within timeout; treating connection as lost', {
        msSinceLastMessage: Date.now() - this.lastServerMessageAt,
        timeoutMs: CONNECTION_STALE_TIMEOUT_MS,
      });
      this.stopHeartbeat();
      // close() drives onclose -> scheduleReconnect (not the permanent banner).
      try {
        socket.close();
      } catch {
        this.state.isConnected = false;
        this.state.socket = null;
        if (this.hasConnectedOnce && !this.userRequestedDisconnect) {
          this.scheduleReconnect();
        }
      }
    }
  }

  // Player management
  setLocalPlayerName(name: string): void {
    logger.debug('NETWORK', `Setting local player name: ${name}`);
    this.localPlayerName = name;
  }

  getLocalPlayerName(): string {
    return this.localPlayerName;
  }

  getLocalPlayerId(): string {
    // Join uses clientId until the server `joined` echo sets localPlayerId (same value).
    return this.localPlayerId || this.clientId;
  }

  private getLocalPlayerColor(): string {
    // Get the local player's color from the player manager
    const playerManager = PlayerManager.getInstance();
    const localPlayer = playerManager.getLocalPlayer();
    return localPlayer?.color || PALETTE.LOCAL;
  }

  private getLocalPlayerPosition(): { x: number; y: number } {
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    if (localPlayer?.ship?.position) {
      return { x: localPlayer.ship.position.x, y: localPlayer.ship.position.y };
    }
    return { x: 0, y: 0 };
  }

  getAllPlayers(): Player[] {
    return this.playerListCache.allPlayers(this.allPlayers);
  }

  getRemotePlayers(): Player[] {
    return this.playerListCache.remotePlayers(this.allPlayers);
  }

  private rememberPlayer(id: string, player: Player): void {
    const previous = this.allPlayers.get(id);
    this.allPlayers.set(id, player);
    if (previous !== player) {
      this.playerListCache.invalidate();
    }
  }

  private forgetPlayer(id: string): void {
    if (this.allPlayers.delete(id)) {
      this.playerListCache.invalidate();
    }
  }

  getPlayer(playerId: string): Player | undefined {
    return this.allPlayers.get(playerId);
  }

  // Send player state to server
  sendPlayerState(
    playerState: Omit<PlayerUpdate, 'lives' | 'score'> & {
      lives?: number;
      score?: number;
    }
  ): void {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.updateEnvelope.data = playerState;
    this.updateEnvelope.timestamp = Date.now();
    this.state.socket.send(JSON.stringify(this.updateEnvelope));
  }

  // Send shoot event to server
  sendShootEvent(laserPosition: Position, laserVelocity: Velocity): void {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      logger.debug('NETWORK', 'Cannot send shoot event - not connected or no socket');
      return;
    }

    const message: ClientMessage = {
      type: 'shoot',
      id: this.localPlayerId || this.clientId,
      data: {
        laserStart: laserPosition,
        laserDirection: laserVelocity,
      },
      timestamp: Date.now(),
    };

    logger.debug('NETWORK', 'Sending shoot message to server', { message });
    this.state.socket.send(JSON.stringify(message));
  }

  // Initialize asteroid sync
  initializeAsteroidSync(): void {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      logger.warn('NETWORK', 'Cannot initialize asteroid sync - not connected');
      return;
    }

    logger.debug('NETWORK', `Initializing asteroid sync with player name: ${this.localPlayerName}`);

    // Align local player id with join id before the first gameState (avoids a
    // transient remote duplicate keyed by clientId).
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    if (localPlayer) {
      localPlayer.id = this.clientId;
      const selectedKit = getSelectedShipKitId();
      if (localPlayer.ship.kitId !== selectedKit) {
        applyShipKitToShip(localPlayer.ship, selectedKit);
      }
    }

    // Get the player's current position
    const playerPosition = this.getLocalPlayerPosition();

    // First join the game
    const joinMessage: ClientMessage = {
      type: 'join',
      id: this.clientId,
      data: {
        name: this.localPlayerName,
        color: this.getLocalPlayerColor(),
        position: playerPosition,
        kitId: localPlayer?.ship.kitId ?? getSelectedShipKitId(),
      },
      timestamp: Date.now(),
    };

    logger.debug('NETWORK', 'Sending join message', { message: joinMessage });
    const jsonString = JSON.stringify(joinMessage);
    this.state.socket.send(jsonString);
  }

  // Initialize asteroids after the server acknowledges join
  private initializeAsteroids(): void {
    if (this.hasInitializedAsteroidsForConnection) {
      return;
    }
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      logger.warn('NETWORK', 'Cannot initialize asteroids - not connected');
      return;
    }
    if (!this.localPlayerId) {
      logger.warn('NETWORK', 'Cannot initialize asteroids - missing local player id');
      return;
    }

    logger.debug('NETWORK', 'Sending initAsteroids message', {
      playerId: this.localPlayerId,
      asteroidCount: ROID.INITIAL_ROID_COUNT,
    });

    const message: ClientMessage = {
      type: 'initAsteroids',
      id: this.localPlayerId,
      data: { asteroidCount: ROID.INITIAL_ROID_COUNT },
      timestamp: Date.now(),
    };

    this.state.socket.send(JSON.stringify(message));
    this.hasInitializedAsteroidsForConnection = true;
    logger.debug('NETWORK', 'Sent initAsteroids message', { message });
  }

  // Send a generic message to the server
  sendMessage(message: Record<string, unknown>): void {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.state.socket.send(JSON.stringify(message));
    logger.debug('NETWORK', 'Sent message', { message });
  }

  private handleServerMessage(message: ServerMessage): void {
    // Prefer message.data, fallback to message.payload for backward compatibility
    const data = (message.data ?? message.payload) as unknown;
    switch (message.type) {
      case 'gameState':
        this.handleGameState(data as ServerGameState);
        break;
      case 'joined':
        this.handleJoined(data as PlayerJoin);
        break;
      case 'playerJoined':
        this.handlePlayerJoined(data as PlayerJoin);
        break;
      case 'playerLeft':
        this.handlePlayerLeft(data as PlayerLeave);
        break;
      case 'asteroidCreate':
        this.handleAsteroidCreated(data as { asteroid: AsteroidData });
        break;
      case 'asteroidCreateBatch':
        this.handleAsteroidCreateBatch(data as { asteroids: AsteroidData[] });
        break;
      case 'asteroidUpdate':
        this.handleAsteroidUpdated(data as { asteroidId: string; updates: Partial<AsteroidData> });
        break;
      case 'asteroidDestroy':
        this.handleAsteroidDestroyed(data as AsteroidDestroyEvent);
        break;
      case 'asteroidTagged':
        this.handleAsteroidTagged(data as AsteroidTaggedEvent);
        break;
      case 'shockwave':
        this.handleShockwave(data as ShockwaveEvent);
        break;
      case 'botCreated':
        this.handleBotCreated(data as { botId: string; botName: string; position: Position });
        break;
      case 'botUpdate':
        this.handleBotUpdated(
          data as {
            botId: string;
            playerId: string;
            position: Position;
            velocity: Velocity;
            angle: number;
            exploding: boolean;
            thrusting?: boolean;
            color: string;
            lives: number;
            health: number;
            maxHealth: number;
          }
        );
        break;
      case 'botDestroyed':
        this.handleBotDestroyed(data as { botId: string });
        break;
      case 'satelliteShoot':
        this.handleSatelliteShoot(data as SatelliteShoot);
        break;
      case 'satellitePickupCollected':
        this.handleSatellitePickupCollected(data as SatellitePickupCollected);
        break;
      case 'playerShoot':
        this.handlePlayerShoot(
          data as {
            id: string;
            laserStart: Position;
            laserDirection: Velocity;
          }
        );
        break;
      case 'playerUpdate':
        // Handle player update messages (currently just log them)
        logger.debug('NETWORK', 'Received player update', { data });
        break;
      case 'playerDamaged':
        this.handlePlayerDamaged(
          data as {
            targetPlayerId: string;
            attackerId: string;
            damage: number;
            remainingHealth: number;
            isDestroyed: boolean;
            remainingLives?: number;
          }
        );
        break;
      case 'playerKilled':
        this.handlePlayerKilled(
          data as {
            targetPlayerId: string;
            targetPlayerName: string;
            attackerId: string;
          }
        );
        break;
      case 'lootExploded':
        this.handleLootExploded(
          data as { lootId: string; position: Position; radius: number; shooterId: string }
        );
        break;
      case 'abilityUsed':
        this.handleAbilityUsed(
          data as {
            id?: string;
            kitId?: string;
            abilityId?: string;
            harpoonTimer?: number;
            harpoonTargetId?: string;
            harpoonLatchPos?: Position;
          }
        );
        break;
      case 'error':
        // Handle error messages from server
        logger.warn('NETWORK', 'Server error', { error: data });
        break;
      default:
        logger.debug('NETWORK', 'Unhandled server message type', { type: message.type });
    }
  }

  private handleAbilityUsed(data: {
    id?: string;
    harpoonTimer?: number;
    harpoonTargetId?: string;
    harpoonLatchPos?: Position;
  }): void {
    if (!data.id) {
      return;
    }
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    const entity =
      this.allPlayers.get(data.id) ?? (localPlayer?.id === data.id ? localPlayer : undefined);
    if (!entity) {
      return;
    }
    const latch = {
      ...(data.harpoonTimer !== undefined ? { harpoonTimer: data.harpoonTimer } : {}),
      ...(data.harpoonTargetId !== undefined ? { harpoonTargetId: data.harpoonTargetId } : {}),
      ...(data.harpoonLatchPos !== undefined ? { harpoonLatchPos: data.harpoonLatchPos } : {}),
    };
    entity.updateFromServer(latch);
    if (localPlayer && localPlayer !== entity && localPlayer.id === data.id) {
      localPlayer.updateFromServer(latch);
    }
  }

  private handleGameState(data: ServerGameState): void {
    applyTerrainSeed(data.terrainSeed);

    // Update local game state from server using unified entity system
    if (data.entities) {
      const localPlayer = PlayerManager.getInstance().getLocalPlayer();
      fillSnapshotEntityIds(data.entities, this.snapshotEntityIds);

      // Update entities in place - no clearing to prevent bot disappearance!
      for (const entityData of data.entities) {
        const isLocalPlayer = isLocalGameEntity(entityData, {
          clientId: this.clientId,
          localPlayerId: this.localPlayerId,
          localPlayerName: this.localPlayerName,
        });

        let entity = this.allPlayers.get(entityData.id);

        if (!entity) {
          if (isLocalPlayer) {
            // Adopt the game-loop's local player as the single source of truth
            // for the local ship, so server-authoritative state (health, score,
            // lives, respawn) flows into the same object the game loop renders,
            // collides, and attributes damage with. Align its id to the
            // server-assigned id.
            if (localPlayer) {
              const previousId = localPlayer.id;
              localPlayer.id = entityData.id;
              if (this.localPlayerName) {
                localPlayer.name = this.localPlayerName;
              }
              entity = localPlayer;
              if (previousId && previousId !== entityData.id) {
                this.forgetPlayer(previousId);
              }
            }
          }

          if (!entity) {
            if (!entityData.name || !entityData.type) {
              continue;
            }
            entity = entityFactory.createPlayer({
              id: entityData.id,
              name: entityData.name,
              type: entityData.type === 'bot' ? 'bot' : 'remote',
              color: entityData.color,
              kitId: entityData.kitId,
              factionId: entityData.factionId,
              position: entityData.position,
            });
          }

          this.rememberPlayer(entityData.id, entity);
        } else if (isLocalPlayer && localPlayer && entity !== localPlayer) {
          this.allPlayers.delete(entityData.id);
          const previousId = localPlayer.id;
          localPlayer.id = entityData.id;
          if (this.localPlayerName) {
            localPlayer.name = this.localPlayerName;
          }
          entity = localPlayer;
          this.rememberPlayer(entityData.id, entity);
          if (previousId && previousId !== entityData.id) {
            this.forgetPlayer(previousId);
          }
        }

        // Apply the parsed entity directly — no per-tick snapshot wrapper.
        // Kit / faction / ability / deathCause / mass / F-key shield stay on the row.
        entity.updateFromServer(entityData);

        if (isLocalPlayer && localPlayer && localPlayer !== entity) {
          localPlayer.updateFromServer(entityData);
        }
      }

      // Drop remotes that vanished from the snapshot so a closed tab leaves
      // the leaderboard even if `playerLeft` was missed. Bots are left alone.
      if (data.entities.length > 0) {
        const removedRemotes = pruneStaleRemotePlayers(this.allPlayers, this.snapshotEntityIds);
        const removedDupes = pruneDuplicateOwnRemotes(this.allPlayers, this.localPlayerName);
        if (removedRemotes + removedDupes > 0) {
          this.playerListCache.invalidate();
          logger.info('NETWORK', 'Removed departed remote players', {
            remotes: removedRemotes,
            duplicates: removedDupes,
          });
        }
      }
    }

    // Apply the authoritative field: create unseen roids, then keep pose in sync
    // so late joiners and every client share the same moving asteroids.
    if (data.asteroids) {
      this.applyAuthoritativeAsteroids(data.asteroids);
    }

    if (Array.isArray(data.loot)) {
      LootField.getInstance().applySnapshot(data.loot as LootData[]);
    }

    if (Array.isArray(data.satellites)) {
      SatelliteManager.getInstance().syncFromServer(data.satellites);
    }
    if (Array.isArray(data.satellitePickups)) {
      SatellitePickupManager.getInstance().syncFromServer(data.satellitePickups);
    }
  }

  private handleLootExploded(data: {
    lootId: string;
    position: Position;
    radius: number;
    shooterId: string;
  }): void {
    if (!data.lootId) {
      return;
    }
    LootField.getInstance().remove(data.lootId);
    if (data.position && Number.isFinite(data.radius)) {
      LootField.getInstance().noteBlast(data.position, data.radius);
    }
  }

  private applyAuthoritativeAsteroids(asteroids: AsteroidData[]): void {
    applyAsteroidFieldPartition(
      partitionAsteroidSnapshot(asteroids, this.seenAsteroidIds, this.asteroidScratch)
    );
  }

  private handleJoined(data: PlayerJoin): void {
    logger.info(
      'NETWORK',
      'Player joined successfully',
      data as unknown as Record<string, unknown>
    );

    const keepField = shouldPreserveSeenAsteroidsOnJoin(this.seenAsteroidIds.size);
    if (!keepField) {
      this.seenAsteroidIds.clear();
      LootField.getInstance().clear();
      SatelliteManager.getInstance().clear();
      SatellitePickupManager.getInstance().clear();
    }
    // `keepField` controls whether the warm local belt is retained. It must
    // not suppress the handshake: a reconnect can land on a fresh server
    // process whose asteroid manager is empty.
    this.hasInitializedAsteroidsForConnection = false;

    applyTerrainSeed(data.terrainSeed);

    // Store the local player ID from server response
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    if (localPlayer) {
      localPlayer.resetCombatLifecycle();
    }
    if (data.id) {
      if (localPlayer?.id && localPlayer.id !== data.id) {
        this.forgetPlayer(localPlayer.id);
      }
      this.localPlayerId = data.id;
      if (localPlayer) {
        localPlayer.id = data.id;
      }
    }
    if (localPlayer) {
      const selectedKit = getSelectedShipKitId();
      if (localPlayer.ship.kitId !== selectedKit) {
        applyShipKitToShip(localPlayer.ship, selectedKit);
      }
    }
    if (data.factionId && localPlayer) {
      localPlayer.factionId = data.factionId;
      localPlayer.ship.factionId = data.factionId;
    }
    this.initializeAsteroids();
  }

  private handlePlayerJoined(data: PlayerJoin): void {
    logger.info('NETWORK', 'Player joined', data as unknown as Record<string, unknown>);
    // Player handling is now done through unified entity system in handleGameState
  }

  private handlePlayerLeft(data: PlayerLeave): void {
    logger.info('NETWORK', 'Player left', data as unknown as Record<string, unknown>);
    if (data.id) {
      this.forgetPlayer(data.id);
    }
  }

  private handleAsteroidCreated(data: { asteroid: AsteroidData }): void {
    if (data.asteroid?.id && asteroidHasSpawnPose(data.asteroid)) {
      this.seenAsteroidIds.add(data.asteroid.id);
    }
    notifyAsteroidCreated(data.asteroid);
  }

  private handleAsteroidCreateBatch(data: { asteroids: AsteroidData[] }): void {
    if (data.asteroids && Array.isArray(data.asteroids)) {
      this.applyAuthoritativeAsteroids(data.asteroids);
    }
  }

  private handleAsteroidUpdated(data: {
    asteroidId: string;
    updates: Partial<AsteroidData>;
  }): void {
    notifyAsteroidUpdated(data.asteroidId, data.updates);
  }

  private handleAsteroidDestroyed(data: AsteroidDestroyEvent): void {
    notifyAsteroidDestroyed({
      asteroidId: data.asteroidId,
      collabSplit: data.collabSplit === true,
      origin: data.origin,
    });
  }

  private handleAsteroidTagged(data: AsteroidTaggedEvent): void {
    if (!data?.asteroidId) {
      return;
    }
    notifyAsteroidTagged(data);
  }

  private handleShockwave(data: ShockwaveEvent): void {
    if (!data?.origin) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent('serverShockwave', {
        detail: {
          origin: { x: data.origin.x, y: data.origin.y },
          asteroidId: data.asteroidId,
        },
      })
    );
  }

  private handleBotCreated(data: { botId: string; botName: string; position: Position }): void {
    logger.debug('NETWORK', 'Bot created', { botId: data.botId, botName: data.botName });
    // Bot handling is now done through unified entity system in handleGameState
  }

  private handleBotUpdated(data: {
    botId: string;
    playerId: string;
    position: Position;
    velocity: Velocity;
    angle: number;
    exploding: boolean;
    thrusting?: boolean;
    color: string;
    lives: number;
    health: number;
    maxHealth: number;
  }): void {
    logger.debug('NETWORK', 'Bot updated', {
      botId: data.botId,
      health: data.health,
      exploding: data.exploding,
    });
    // Bot handling is now done through unified entity system in handleGameState
  }

  private handleSatelliteShoot(data: SatelliteShoot): void {
    logger.debug('NETWORK', 'Satellite shot laser', {
      satelliteId: data.id,
      laserStart: data.laserStart,
      laserDirection: data.laserDirection,
    });
    if (typeof data.shotId !== 'string' || data.shotId.length === 0) {
      return;
    }
    SatelliteManager.getInstance().addLaser(
      data.id,
      data.shotId,
      data.laserStart,
      data.laserDirection
    );
  }

  private handleSatellitePickupCollected(data: SatellitePickupCollected): void {
    if (!data?.playerId || !data.pickupId) {
      return;
    }
    window.dispatchEvent(new CustomEvent('satellitePickupCollected', { detail: data }));
  }

  private handleBotDestroyed(data: { botId: string }): void {
    logger.debug('NETWORK', 'Bot destroyed', { botId: data.botId });

    if (data.botId) {
      this.forgetPlayer(data.botId);
    }
  }

  private handlePlayerShoot(data: {
    id: string;
    laserStart: Position;
    laserDirection: Velocity;
  }): void {
    logger.debug('NETWORK', 'Client received playerShoot message', data);
    logger.debug('NETWORK', 'Player shot laser', {
      playerId: data.id,
      laserStart: data.laserStart,
      laserDirection: data.laserDirection,
    });

    const player = this.allPlayers.get(data.id);
    if (!player) {
      logger.debug('NETWORK', 'Player not found for laser shot', { playerId: data.id });
      logger.warn('NETWORK', 'Received laser shot for unknown player', { playerId: data.id });
      return;
    }

    if (!shouldApplyRemoteShoot(player, this.getLocalPlayerId(), SHIP.MAX_LASERS)) {
      return;
    }

    // Create a laser for the remote player
    const laser = entityFactory.createLaser({
      position: data.laserStart,
      velocity: data.laserDirection,
      distTraveled: 0,
      explodeTime: 0,
      hasExploded: false,
    });

    // Add the laser to the player's ship
    player.ship.lasers.push(laser);
    // Local shots already played in fireLaser; remote/bot shots share playLaserSound.
    if (player.type !== 'local') {
      playLaserSound(laser.position);
    }
    logger.debug('NETWORK', 'Added laser to remote player', {
      playerId: data.id,
      laserCount: player.ship.lasers.length,
    });
  }

  private handlePlayerDamaged(data: {
    targetPlayerId: string;
    attackerId: string;
    damage: number;
    remainingHealth: number;
    isDestroyed: boolean;
    remainingLives?: number;
  }): void {
    logger.debug('NETWORK', 'Player damaged', {
      targetPlayerId: data.targetPlayerId,
      attackerId: data.attackerId,
      damage: data.damage,
      remainingHealth: data.remainingHealth,
      isDestroyed: data.isDestroyed,
      remainingLives: data.remainingLives,
    });

    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    const isLocalTarget = Boolean(
      localPlayer &&
        (localPlayer.id === data.targetPlayerId || this.getLocalPlayerId() === data.targetPlayerId)
    );
    const prevLocalLives =
      isLocalTarget && localPlayer && data.remainingLives !== undefined
        ? localPlayer.lives
        : undefined;

    let targetPlayer = this.allPlayers.get(data.targetPlayerId);
    if (!targetPlayer) {
      if (isLocalTarget && localPlayer) {
        targetPlayer = localPlayer;
        this.rememberPlayer(data.targetPlayerId, localPlayer);
      }
    }
    if (!targetPlayer) {
      logger.warn('NETWORK', 'Player not found for damage', {
        targetPlayerId: data.targetPlayerId,
      });
      return;
    }

    if (data.attackerId) {
      targetPlayer.deathCause = data.attackerId;
    }
    if (data.remainingLives !== undefined) {
      targetPlayer.lives = data.remainingLives;
    }

    this.applyDamageToLocalPlayerIfTarget(data);

    this.applyAuthoritativeDamageHealth(targetPlayer, data.remainingHealth, data.isDestroyed);

    if (data.remainingHealth > 0 && data.damage > 0) {
      targetPlayer.ship.takeDamage(0, data.attackerId);
    }

    if (data.isDestroyed && !targetPlayer.ship.exploding) {
      targetPlayer.ship.explode(data.attackerId);
    }

    if (
      localPlayer &&
      prevLocalLives !== undefined &&
      data.remainingLives !== undefined &&
      prevLocalLives > data.remainingLives
    ) {
      const deathCause = this.describeAttacker(data.attackerId);
      localPlayer.deathCause = deathCause;
      this.dispatchLocalPlayerDied(localPlayer, data.remainingLives, deathCause);
    }
  }

  /** Fire playerDied when server reports a life loss before game-state sync arrives. */
  private dispatchLocalPlayerDied(
    localPlayer: Player,
    remainingLives: number,
    deathCause: string
  ): void {
    window.dispatchEvent(
      new CustomEvent('playerDied', {
        detail: {
          playerId: localPlayer.id,
          deathCause,
          isGameOver: remainingLives <= 0,
        },
      })
    );
  }

  /** Keep PlayerManager's local ship in sync when damage hits a network duplicate. */
  private applyDamageToLocalPlayerIfTarget(data: {
    targetPlayerId: string;
    remainingHealth: number;
    remainingLives?: number;
    isDestroyed: boolean;
    attackerId: string;
  }): void {
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    if (!localPlayer) {
      return;
    }
    const isLocalTarget =
      localPlayer.id === data.targetPlayerId || this.getLocalPlayerId() === data.targetPlayerId;
    if (!isLocalTarget) {
      return;
    }

    this.applyAuthoritativeDamageHealth(localPlayer, data.remainingHealth, data.isDestroyed);
    if (data.attackerId) {
      localPlayer.deathCause = data.attackerId;
    }
    if (data.remainingLives !== undefined) {
      localPlayer.lives = data.remainingLives;
    }
    if (data.isDestroyed && !localPlayer.ship.exploding) {
      localPlayer.ship.explode(data.attackerId);
    }
  }

  /** Never raise health from playerDamaged — ignored hits echo remainingHealth=100. */
  private applyAuthoritativeDamageHealth(
    player: Player,
    remainingHealth: number,
    isDestroyed: boolean
  ): void {
    if (!shouldApplyDamagedHealth(player.ship.health, remainingHealth, isDestroyed)) {
      return;
    }
    player.ship.health = remainingHealth;
    if (player.type === 'local') {
      player.syncServerHealthEcho(remainingHealth);
    }
  }

  private handlePlayerKilled(data: {
    targetPlayerId: string;
    targetPlayerName: string;
    attackerId: string;
  }): void {
    const localId = this.localPlayerId ?? this.clientId;
    if (data.attackerId !== localId) {
      return;
    }

    window.dispatchEvent(
      new CustomEvent('remotePlayerDied', {
        detail: {
          playerId: data.targetPlayerId,
          playerName: data.targetPlayerName,
          deathCause: 'laser',
        },
      })
    );
  }
}
