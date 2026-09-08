import {
  SNAPSHOT_VERSION,
  SnapshotDecoder,
  type SnapshotFrame,
} from '../../../shared/snapshotProtocol';
import {
  captureDiagnosticActorState,
  shouldSampleSnapshot,
} from '../../../shared/stateDiagnostics';
import type {
  AsteroidData,
  AsteroidDestroyEvent,
  AsteroidMotionInput,
  AsteroidTaggedEvent,
  LootData,
  PlayerJoin,
  PlayerLeave,
  PlayerUpdate,
  Position,
  SatellitePickupCollected,
  SatelliteShoot,
  ServerGameSnapshot,
  ServerGameState,
  ShockwaveEvent,
  Velocity,
} from '../../../shared-types';
import { playLaserSound } from '../../audio/gameSounds';
import { PALETTE, ROID, SHIP } from '../../constants';
import { entityFactory } from '../../entities/EntityFactory';
import { AuthoritativeProjectileField } from '../../entities/laser/AuthoritativeProjectileField';
import { LootField } from '../../entities/loot/LootField';
import type { Player } from '../../entities/player/Player';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { shouldApplyRemoteShoot } from '../../entities/player/remoteLasers';
import { SatelliteManager } from '../../entities/satellite/SatelliteManager';
import { SatellitePickupManager } from '../../entities/satellitePickup/SatellitePickupManager';
import { setHoldEmptyHarpoonField } from '../../entities/ship/harpoonField';
import { applyShipKitToShip, DEFAULT_SHIP_KIT_ID } from '../../entities/ship/shipKits';
import { shouldApplyDamagedHealth } from '../../entities/ship/shipUtils';
import { applyTerrainSeed } from '../../physics/terrain/terrainSession';
import { getSelectedShipKitId } from '../../ui/shipKitSelect';
import { setClientLogContext } from '../../utils/clientLogContext';
import { describeDeathCause } from '../../utils/deathCause';
import { logger } from '../../utils/Logger';
import type { ClientMessage, ServerMessage } from '../types';
import { AsteroidMotionPrediction } from './AsteroidMotionPrediction';
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
  CONNECTION_HANDSHAKE_TIMEOUT_MS,
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

type SnapshotDiagnosticMetadata = Pick<SnapshotFrame, 'kind' | 'sequence'> & {
  baseline?: number;
};

let nextConnectionId = 0;

function readSnapshotSequence(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const frame = data as Record<string, unknown>;
  if (!Number.isSafeInteger(frame['sequence']) || (frame['sequence'] as number) <= 0) {
    return undefined;
  }
  return frame['sequence'] as number;
}

function readSnapshotDiagnosticMetadata(
  data: unknown,
  sequence = readSnapshotSequence(data)
): SnapshotDiagnosticMetadata | undefined {
  if (sequence === undefined || !data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  const frame = data as Record<string, unknown>;
  if (frame['kind'] !== 'keyframe' && frame['kind'] !== 'delta') {
    return undefined;
  }
  return {
    kind: frame['kind'],
    sequence,
    ...(frame['kind'] === 'delta' && Number.isSafeInteger(frame['baseline'])
      ? { baseline: frame['baseline'] as number }
      : {}),
  };
}

function captureClientPlayerState(player: Player) {
  return captureDiagnosticActorState({
    position: player.ship.position,
    velocity: player.ship.velocity,
    angle: player.ship.angle,
    health: player.ship.health,
    maxHealth: player.ship.maxHealth,
    lives: player.lives,
    score: player.score,
    exploding: player.ship.exploding,
    spawnProtectionTimer: player.serverSpawnProtectionTimer,
  });
}

export class ConnectionManager {
  private static instance: ConnectionManager;
  private state: ConnectionState;
  private readonly snapshotDecoder = new SnapshotDecoder();
  private snapshotNegotiated = false;
  private snapshotOffered = false;
  private asteroidInteractions = false;
  private resumeToken?: string;
  private readonly motionPrediction = new AsteroidMotionPrediction();
  private motionRocks: AsteroidData[] = [];
  private snapshotResyncPending = false;
  private localHarpoonAcknowledged = false;

  private clientId: string;
  private localPlayerName: string = '';
  private localPlayerId: string = '';
  private allPlayers: Map<string, Player> = new Map();
  private seenAsteroidIds: Set<string> = new Set(); // Track asteroids we've already seen
  private hasInitializedAsteroidsForConnection = false;
  private readonly playerListCache = new PlayerListCache<Player>();
  private readonly snapshotEntityIds = new Set<string>();
  private readonly taggedAsteroidIds = new Set<string>();
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
  private cancelPendingConnect: ((error: Error) => void) | null = null;
  private connectionId = '';
  private serverReleaseId?: string;
  private lastAcceptedSnapshotSequence = 0;
  private lastDamageStateLogAt = 0;

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
    return new Promise((resolve, reject) => {
      this.connectionId = `connection-${++nextConnectionId}`;
      setClientLogContext({ connectionId: this.connectionId });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.cancelPendingConnect = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        const error = new Error('WebSocket connection timed out');
        finish(error);
        if (this.state.socket) {
          this.retireSocket(this.state.socket);
        }
      }, CONNECTION_HANDSHAKE_TIMEOUT_MS);
      this.cancelPendingConnect = finish;
      try {
        const computedUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
        const wsEndpoint = new URL(import.meta.env.VITE_WEBSOCKET_URL || computedUrl);
        if ((import.meta.env['VITE_ASTEROID_INTERACTIONS'] ?? '1') === '1') {
          wsEndpoint.searchParams.set('asteroidInteractions', '1');
        }
        logger.debug('NETWORK', 'Connecting to WebSocket', { url: wsEndpoint.toString() });
        this.resetSnapshotSession();
        const socket = new WebSocket(wsEndpoint.toString());
        this.state.socket = socket;
        socket.onopen = (): void => {
          if (this.state.socket !== socket || settled) {
            return;
          }
          const wasReconnect = this.hasConnectedOnce;
          const completedReconnectAttempts = this.reconnectAttempt;
          this.state.isConnected = true;
          this.lastServerMessageAt = Date.now();
          this.reconnectAttempt = 0;
          this.startHeartbeat();
          this.hasConnectedOnce = true;
          logger.info('NETWORK', wasReconnect ? 'Reconnected to server' : 'Connected to server');
          logger.info('STATE', 'transport_connected', {
            connectedAt: Date.now(),
            connectionAttempt: completedReconnectAttempts + 1,
            reconnected: wasReconnect,
          });
          finish();
          window.dispatchEvent(
            new CustomEvent(wasReconnect ? 'networkReconnected' : 'networkConnected')
          );
        };
        socket.onerror = (): void => {
          if (this.state.socket !== socket) {
            return;
          }
          const error = new Error('WebSocket connection failed');
          logger.error('NETWORK', 'WebSocket connection error', error);
          finish(error);
          this.retireSocket(socket);
        };
        socket.onclose = (): void => {
          if (this.state.socket !== socket) {
            return;
          }
          finish(new Error('WebSocket closed before connecting'));
          this.handleSocketClosed(socket);
        };
        socket.onmessage = (event: MessageEvent): void => {
          if (this.state.socket !== socket) {
            return;
          }
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
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)));
        if (this.state.socket) {
          this.retireSocket(this.state.socket);
        }
      }
    });
  }

  private handleSocketClosed(socket: WebSocket): void {
    if (this.state.socket !== socket) {
      return;
    }
    const wasConnected = this.state.isConnected;
    const serverReleaseId = this.serverReleaseId;
    const lastAcceptedSnapshotSequence = this.lastAcceptedSnapshotSequence;
    this.motionPrediction.transportClosed();
    const localShip = PlayerManager.getInstance().getLocalShip();
    if (localShip && this.asteroidInteractions) {
      localShip.serverOwnsMotion = true;
    }
    this.resetSnapshotSession();
    this.state.isConnected = false;
    this.state.socket = null;
    this.stopHeartbeat();
    this.hasInitializedAsteroidsForConnection = false;
    // Preserve the visible belt while the next socket rejoins the authoritative world.
    setHoldEmptyHarpoonField(true);
    logger.warn('NETWORK', 'WebSocket connection closed');
    logger.info('STATE', 'transport_closed', {
      closedAt: Date.now(),
      wasConnected,
      userRequested: this.userRequestedDisconnect,
      lastAcceptedSnapshotSequence,
      ...(serverReleaseId ? { serverReleaseId } : {}),
    });
    // Failed handshakes are retried by the awaiting reconnect attempt; only
    // a previously open transport starts a new retry sequence here.
    if (wasConnected && !this.userRequestedDisconnect && this.hasConnectedOnce) {
      this.scheduleReconnect();
    }
  }

  private retireSocket(socket: WebSocket): void {
    this.handleSocketClosed(socket);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch (error) {
      logger.error(
        'NETWORK',
        'Failed to close retired WebSocket',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /** A failed send invalidates the transport; commands are never silently queued. */
  private sendPayload(message: unknown): boolean {
    const socket = this.state.socket;
    if (!this.state.isConnected || !socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.error(
        'NETWORK',
        'Failed to send gameplay message',
        error instanceof Error ? error : new Error(String(error))
      );
      this.retireSocket(socket);
      return false;
    }
  }

  disconnect(options?: { newSession?: boolean }): void {
    this.userRequestedDisconnect = true;
    this.cancelPendingConnect?.(new Error('WebSocket connection cancelled'));
    if (this.state.socket?.readyState === WebSocket.OPEN && this.asteroidInteractions) {
      this.sendPayload({ type: 'leave', data: {} });
    }
    delete this.resumeToken;
    this.asteroidInteractions = false;
    this.motionPrediction.reset();
    const localShip = PlayerManager.getInstance().getLocalShip();
    if (localShip) {
      localShip.serverOwnsMotion = false;
      delete localShip.asteroidMotion;
    }
    AuthoritativeProjectileField.getInstance().clear();
    window.dispatchEvent(new CustomEvent('asteroidToolsSnapshot', { detail: { enabled: false } }));
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    const socket = this.state.socket;
    if (socket) {
      this.retireSocket(socket);
    }
    this.resetSnapshotSession();
    this.state.isConnected = false;
    this.state.socket = null;
    this.allPlayers.clear();
    this.taggedAsteroidIds.clear();
    this.playerListCache.invalidate();
    this.seenAsteroidIds.clear();
    this.hasInitializedAsteroidsForConnection = false;
    LootField.getInstance().clear();
    SatelliteManager.getInstance().clear();
    SatellitePickupManager.getInstance().clear();
    this.localPlayerId = '';
    this.lastDamageStateLogAt = 0;
    setClientLogContext({});
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
      logger.warn('STATE', 'reconnect_exhausted', {
        observedAt: Date.now(),
        attempts: this.reconnectAttempt,
      });
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
    logger.info('STATE', 'reconnect_scheduled', {
      scheduledAt: Date.now(),
      attempt: this.reconnectAttempt + 1,
      delayMs: delay,
    });
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

    this.pingPayload.timestamp = Date.now();
    if (!this.sendPayload(this.pingPayload)) {
      return;
    }

    if (isConnectionStale(this.lastServerMessageAt, Date.now())) {
      logger.warn('NETWORK', 'No server traffic within timeout; treating connection as lost', {
        msSinceLastMessage: Date.now() - this.lastServerMessageAt,
        timeoutMs: CONNECTION_STALE_TIMEOUT_MS,
      });
      this.stopHeartbeat();
      this.retireSocket(socket);
    }
  }

  // Player management
  setLocalPlayerName(name: string): void {
    logger.debug('NETWORK', 'Setting local player name');
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

    if (this.asteroidInteractions) {
      const ship = PlayerManager.getInstance().getLocalShip();
      if (!ship) {
        return;
      }
      const input = this.motionPrediction.buildInput(ship, Date.now());
      if (input) {
        this.sendMessage({ type: 'asteroidInput', data: input });
      }
      this.motionPrediction.predictFrame(ship, Date.now(), this.motionRocks);
      const pose = this.motionPrediction.buildHandoffPose(ship);
      if (pose) {
        Object.assign(playerState, pose);
      }
      const reason = this.motionPrediction.recoveryReason();
      if (reason && !this.snapshotResyncPending) {
        logger.warn('NETWORK', reason);
        this.sendMessage({ type: 'snapshotResync', data: {} });
        this.snapshotResyncPending = true;
      }
      if (!pose && this.motionPrediction.shouldSuppressPose()) {
        return;
      }
    }
    this.updateEnvelope.data = playerState;
    this.updateEnvelope.timestamp = Date.now();
    this.sendPayload(this.updateEnvelope);
  }

  dispatchAsteroidMotionAction(
    action: NonNullable<AsteroidMotionInput['action']>,
    targetId?: string
  ): boolean {
    const ship = PlayerManager.getInstance().getLocalShip();
    if (!ship || !this.asteroidInteractions) {
      return false;
    }
    const input = this.motionPrediction.buildInput(ship, Date.now(), {
      action,
      ...(targetId ? { targetId } : {}),
    });
    if (!input) {
      return false;
    }
    return this.sendMessage({ type: 'asteroidInput', data: input });
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

    logger.debug('NETWORK', 'Sending shoot message to server', { playerId: message.id });
    this.sendPayload(message);
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

    logger.debug('NETWORK', 'Initializing asteroid sync');

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

    // A same-socket rejoin can race snapshots already queued by the server.
    // Keep its current decoder/format until the ordered joined acknowledgment
    // establishes the new session. New physical sockets reset in openSocket.
    this.snapshotOffered = (import.meta.env['VITE_SNAPSHOT_PROTOCOL'] ?? '1') === '1';

    // First join the game
    const joinMessage: ClientMessage = {
      type: 'join',
      id: this.clientId,
      data: {
        name: this.localPlayerName,
        color: this.getLocalPlayerColor(),
        position: playerPosition,
        kitId: localPlayer?.ship.kitId ?? getSelectedShipKitId(),
        ...(this.snapshotOffered ? { snapshotVersion: SNAPSHOT_VERSION } : {}),
        ...(this.snapshotOffered && (import.meta.env['VITE_ASTEROID_INTERACTIONS'] ?? '1') === '1'
          ? {
              asteroidInteractions: 1,
              ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
            }
          : {}),
      },
      timestamp: Date.now(),
    };

    logger.debug('NETWORK', 'Sending join message', {
      id: this.clientId,
      resumable: !!this.resumeToken,
    });
    this.sendPayload(joinMessage);
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

    if (!this.sendPayload(message)) {
      return;
    }
    this.hasInitializedAsteroidsForConnection = true;
    logger.debug('NETWORK', 'Sent initAsteroids message', { playerId: this.localPlayerId });
  }

  // Send a generic message to the server
  sendMessage(message: Record<string, unknown>): boolean {
    if (!this.sendPayload(message)) {
      return false;
    }
    if (
      message['type'] === 'useAbility' &&
      (message['data'] as { abilityId?: unknown } | undefined)?.abilityId === 'harpoon'
    ) {
      this.localHarpoonAcknowledged = false;
    }
    logger.debug('NETWORK', 'Sent message', {
      messageType: typeof message['type'] === 'string' ? message['type'] : 'unknown',
    });
    return true;
  }

  private handleServerMessage(message: ServerMessage): void {
    // Prefer message.data, fallback to message.payload for backward compatibility
    const data = (message.data ?? message.payload) as unknown;
    switch (message.type) {
      case 'snapshot':
        this.handleSnapshot(data);
        break;
      case 'gameState':
        if (this.snapshotNegotiated) {
          this.requestSnapshotResync(new Error('Legacy state after snapshot negotiation'));
          break;
        }
        this.applyReceivedGameState(data as ServerGameState);
        break;
      case 'sessionExpired': {
        // Remove the previous map key before initializeAsteroidSync changes
        // the local Player object's id for the replacement session.
        const localPlayer = PlayerManager.getInstance().getLocalPlayer();
        if (localPlayer?.id) {
          this.forgetPlayer(localPlayer.id);
        }
        if (this.localPlayerId) {
          this.forgetPlayer(this.localPlayerId);
        }
        this.localPlayerId = '';
        setClientLogContext({ connectionId: this.connectionId });
        delete this.resumeToken;
        this.motionPrediction.reset();
        this.asteroidInteractions = false;
        this.clientId = replaceStoredClientId();
        this.initializeAsteroidSync();
        break;
      }
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
        logger.debug('NETWORK', 'Received player update');
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

  private resetSnapshotSession(): void {
    this.snapshotDecoder.reset();
    this.snapshotNegotiated = false;
    this.snapshotOffered = false;
    this.snapshotResyncPending = false;
    this.localHarpoonAcknowledged = false;
    this.lastAcceptedSnapshotSequence = 0;
    delete this.serverReleaseId;
  }

  private requestSnapshotResync(
    error: unknown,
    metadata?: SnapshotDiagnosticMetadata,
    receivedAt = Date.now()
  ): void {
    logger.error(
      'STATE',
      'snapshot_rejected',
      error instanceof Error ? error : new Error('Unknown snapshot error'),
      {
        receivedAt,
        lastAcceptedSequence: this.lastAcceptedSnapshotSequence,
        expectedSequence: this.lastAcceptedSnapshotSequence + 1,
        ...(metadata
          ? {
              receivedSequence: metadata.sequence,
              receivedKind: metadata.kind,
              ...(metadata.baseline !== undefined ? { receivedBaseline: metadata.baseline } : {}),
            }
          : {}),
        ...(this.serverReleaseId ? { serverReleaseId: this.serverReleaseId } : {}),
      }
    );
    if (!this.snapshotNegotiated) {
      this.state.socket?.close(1002, 'Snapshot was not negotiated');
      return;
    }
    if (!this.snapshotResyncPending) {
      this.snapshotResyncPending = true;
      this.sendMessage({ type: 'snapshotResync', data: {}, timestamp: Date.now() });
    }
  }

  private handleSnapshot(data: unknown): void {
    const receivedAt = Date.now();
    const sequence = readSnapshotSequence(data);
    const sampled = sequence !== undefined && shouldSampleSnapshot(sequence);
    const metadata = sampled ? readSnapshotDiagnosticMetadata(data, sequence) : undefined;
    const localBefore = sampled ? PlayerManager.getInstance().getLocalPlayer() : undefined;
    const clientBeforeApply = localBefore ? captureClientPlayerState(localBefore) : undefined;
    try {
      if (!this.snapshotNegotiated) {
        throw new Error('Snapshot was not negotiated');
      }
      const state = this.snapshotDecoder.decode(data);
      this.snapshotResyncPending = false;
      this.applyReceivedGameState(state, true);
      if (sequence !== undefined) {
        this.lastAcceptedSnapshotSequence = sequence;
      }
      if (sampled && metadata) {
        const authoritative = state.entities.find(
          (entity) => entity.id === (this.localPlayerId || this.clientId)
        );
        const localAfter = PlayerManager.getInstance().getLocalPlayer();
        logger.info('STATE', 'snapshot_applied', {
          receivedAt,
          gameTime: state.gameTime,
          snapshotSequence: metadata.sequence,
          snapshotKind: metadata.kind,
          ...(metadata.baseline !== undefined ? { snapshotBaseline: metadata.baseline } : {}),
          ...(this.serverReleaseId ? { serverReleaseId: this.serverReleaseId } : {}),
          ...(authoritative?.asteroidMotion
            ? {
                motionEpoch: authoritative.asteroidMotion.epoch,
                motionAck: authoritative.asteroidMotion.ack,
                motionMode: authoritative.asteroidMotion.mode,
              }
            : {}),
          ...(clientBeforeApply ? { clientBeforeApply } : {}),
          ...(authoritative
            ? { authoritativeRow: captureDiagnosticActorState(authoritative) }
            : {}),
          ...(localAfter ? { clientAfterApply: captureClientPlayerState(localAfter) } : {}),
        });
      }
    } catch (error) {
      this.requestSnapshotResync(
        error,
        metadata ?? readSnapshotDiagnosticMetadata(data, sequence),
        receivedAt
      );
    }
  }

  private applyReceivedGameState(data: ServerGameState, complete = false): void {
    const localBefore = PlayerManager.getInstance().getLocalPlayer();
    const wasDead = Boolean(
      localBefore && (localBefore.ship.health <= 0 || localBefore.ship.exploding)
    );
    this.handleGameState(data, complete);
    if (!wasDead) {
      return;
    }
    const localAfter = PlayerManager.getInstance().getLocalPlayer();
    if (localAfter && localAfter.ship.health > 0 && !localAfter.ship.exploding) {
      logger.info('STATE', 'player_respawned', {
        receivedAt: Date.now(),
        gameTime: data.gameTime,
        state: captureClientPlayerState(localAfter),
        ...(this.serverReleaseId ? { serverReleaseId: this.serverReleaseId } : {}),
      });
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
    if (localPlayer?.id === data.id && (data.harpoonTimer ?? 0) > 0) {
      this.localHarpoonAcknowledged = true;
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

  private handleGameState(data: ServerGameState, complete = false): void {
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
          localPlayerName: complete ? '' : this.localPlayerName,
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
            if (!complete && (!entityData.name || !entityData.type)) {
              continue;
            }
            entity = entityFactory.createPlayer({
              id: entityData.id,
              name: entityData.name,
              type: entityData.type === 'bot' ? 'bot' : 'remote',
              color: entityData.color,
              ...(entityData.kitId !== undefined ? { kitId: entityData.kitId } : {}),
              ...(entityData.factionId !== undefined ? { factionId: entityData.factionId } : {}),
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
        // A gameState row is complete: omission means protection expired.
        // Partial playerUpdate messages retain their existing merge semantics.
        entityData.spawnProtectionTimer ??= 0;
        if (complete) {
          // Complete snapshots clear optional values that legacy partial updates retain.
          if (entityData.asteroidMotion !== undefined) {
            entity.ship.asteroidMotion = entityData.asteroidMotion;
          } else {
            delete entity.ship.asteroidMotion;
          }
          entity.name = entityData.name;
          if (entityData.factionId !== undefined) {
            entity.factionId = entityData.factionId;
          } else {
            delete entity.factionId;
          }
          if (entityData.factionId !== undefined) {
            entity.ship.factionId = entityData.factionId;
          } else {
            delete entity.ship.factionId;
          }
          if (entity.type !== 'local') {
            entityData.kitId ??= DEFAULT_SHIP_KIT_ID;
          }
          if (isLocalPlayer && (entityData.harpoonTimer ?? 0) > 0) {
            this.localHarpoonAcknowledged = true;
          }
          // Preserve only the existing, locally ticking visual prediction while
          // this socket has not acknowledged its latch. Reconnect does not revive
          // server ability state or extend the timer. Once acknowledged, a zero
          // is authoritative expiry; a missing target also ends warm prediction.
          const targetId = entity.ship.harpoonTargetId;
          const preservePredictedLatch =
            isLocalPlayer &&
            entity.type === 'local' &&
            entity.ship.kitId === 'hauler' &&
            !this.localHarpoonAcknowledged &&
            entity.ship.harpoonTimer > 0 &&
            !entityData.exploding &&
            entityData.health > 0 &&
            (data.asteroids.some((rock) => rock.id === targetId) ||
              data.entities.some((player) => player.id === targetId));
          if (!preservePredictedLatch) {
            entity.ship.abilityCooldownFrames = entityData.abilityCooldownFrames ?? 0;
            entity.ship.abilityActiveFrames = entityData.abilityActiveFrames ?? 0;
            entity.ship.harpoonTimer = entityData.harpoonTimer ?? 0;
            if (entityData.harpoonTargetId !== undefined) {
              entity.ship.harpoonTargetId = entityData.harpoonTargetId;
            } else {
              delete entity.ship.harpoonTargetId;
            }
            if (entityData.harpoonLatchPos !== undefined) {
              entity.ship.harpoonLatchPos = entityData.harpoonLatchPos;
            } else {
              delete entity.ship.harpoonLatchPos;
            }
          }
          entity.ship.shieldTimer = entityData.shieldTimer ?? 0;
          entity.ship.shieldActive = entityData.shieldActive ?? false;
          entity.ship.shieldTime = entityData.shieldTime ?? 0;
          entity.ship.shieldCooldown = entityData.shieldCooldown ?? 0;
          entity.ship.shieldFlashTime = entityData.shieldFlashTime ?? 0;
          if (!entityData.deathCause && !entityData.exploding && entityData.health > 0) {
            delete entity.deathCause;
          }
        }
        entity.updateFromServer(entityData);
        if (isLocalPlayer && this.asteroidInteractions) {
          this.motionPrediction.rebase(entityData, entity.ship, Date.now(), data.asteroids);
          entity.ship.serverOwnsMotion = this.motionPrediction.shouldSuppressShipMove();
          window.dispatchEvent(
            new CustomEvent('asteroidToolsSnapshot', {
              detail: {
                entity: entityData,
                asteroids: data.asteroids,
                enabled: true,
              },
            })
          );
        }

        if (isLocalPlayer && localPlayer && localPlayer !== entity) {
          localPlayer.updateFromServer(entityData);
        }
      }

      // Drop remotes that vanished from the snapshot so a closed tab leaves
      // the leaderboard even if `playerLeft` was missed. Bots are left alone.
      if (complete) {
        for (const [id, entity] of this.allPlayers) {
          if (entity.type !== 'local' && !this.snapshotEntityIds.has(id)) {
            this.forgetPlayer(id);
          }
        }
      }
      if (!complete && data.entities.length > 0) {
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
      this.applyAuthoritativeAsteroids(data.asteroids, complete);
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
    if (complete) {
      const snapshot = data as ServerGameSnapshot;
      this.motionRocks = data.asteroids;
      const projectileField = AuthoritativeProjectileField.getInstance();
      projectileField.sync(snapshot.playerProjectiles ?? [], this.asteroidInteractions);
      if (this.asteroidInteractions) {
        for (const player of this.allPlayers.values()) {
          projectileField.reconcileShip(player.ship, player.id);
        }
      }
      SatelliteManager.getInstance().syncProjectilesFromServer(snapshot.satelliteProjectiles);
      const activeTags = new Set(snapshot.collabTags.map((tag) => tag.asteroidId));
      for (const id of this.taggedAsteroidIds) {
        if (!activeTags.has(id)) {
          notifyAsteroidTagged({ asteroidId: id, shooterId: '', expiresAt: 0 });
        }
      }
      this.taggedAsteroidIds.clear();
      for (const tag of snapshot.collabTags) {
        this.taggedAsteroidIds.add(tag.asteroidId);
        notifyAsteroidTagged({
          asteroidId: tag.asteroidId,
          shooterId: tag.hits[0]?.shooterId ?? '',
          expiresAt: tag.expiresAt,
        });
      }
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

  private applyAuthoritativeAsteroids(asteroids: AsteroidData[], complete = false): void {
    applyAsteroidFieldPartition(
      partitionAsteroidSnapshot(asteroids, this.seenAsteroidIds, this.asteroidScratch, complete),
      complete
    );
  }

  private handleJoined(data: PlayerJoin): void {
    this.snapshotDecoder.reset();
    this.snapshotResyncPending = false;
    this.snapshotNegotiated = this.snapshotOffered && data.snapshotVersion === SNAPSHOT_VERSION;
    if (data.snapshotVersion !== undefined && !this.snapshotNegotiated) {
      this.state.socket?.close(1002, 'Unsupported snapshot negotiation');
      return;
    }
    this.asteroidInteractions =
      this.snapshotNegotiated &&
      data.asteroidInteractions === 1 &&
      typeof data.resumeToken === 'string';
    const resumeTokenValue = this.asteroidInteractions ? data.resumeToken : undefined;
    if (resumeTokenValue !== undefined) {
      this.resumeToken = resumeTokenValue;
    } else {
      delete this.resumeToken;
    }
    if (data.serverReleaseId) {
      this.serverReleaseId = data.serverReleaseId;
    } else {
      delete this.serverReleaseId;
    }
    this.lastDamageStateLogAt = 0;
    setClientLogContext({ playerId: data.id, connectionId: this.connectionId });
    logger.info('STATE', 'player_joined', {
      joinedAt: Date.now(),
      playerId: data.id,
      asteroidInteractions: this.asteroidInteractions,
      ...(data.snapshotVersion !== undefined ? { snapshotVersion: data.snapshotVersion } : {}),
      ...(data.serverReleaseId ? { serverReleaseId: data.serverReleaseId } : {}),
    });

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
      ...(data.origin !== undefined ? { origin: data.origin } : {}),
    });
  }

  private handleAsteroidTagged(data: AsteroidTaggedEvent): void {
    if (!data?.asteroidId) {
      return;
    }
    this.taggedAsteroidIds.add(data.asteroidId);
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
    // Complete keyed projectiles also carry ricochets and survive reconnect.
    // Legacy events never append a second bolt in the negotiated world.
    if (this.asteroidInteractions) {
      return;
    }
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
    const beforeHealth = isLocalTarget && localPlayer ? localPlayer.ship.health : undefined;

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

    if (isLocalTarget) {
      const observedAt = Date.now();
      const shouldLogDamage = data.isDestroyed || observedAt - this.lastDamageStateLogAt >= 1000;
      if (shouldLogDamage) {
        this.lastDamageStateLogAt = observedAt;
        logger.info('STATE', data.isDestroyed ? 'player_died' : 'damage_applied', {
          observedAt,
          playerId: data.targetPlayerId,
          attackerId: data.attackerId,
          damage: data.damage,
          ...(beforeHealth !== undefined ? { healthBefore: beforeHealth } : {}),
          healthAfter: data.remainingHealth,
          ...(prevLocalLives !== undefined ? { livesBefore: prevLocalLives } : {}),
          ...(data.remainingLives !== undefined ? { livesAfter: data.remainingLives } : {}),
          ...(this.serverReleaseId ? { serverReleaseId: this.serverReleaseId } : {}),
        });
      }
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
