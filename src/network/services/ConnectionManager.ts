import { validExploration } from '../../../shared/exploration';
import { releaseField } from '../../../shared/releaseId';
import { containBodyOutOfCompletedSectors } from '../../../shared/sectors';
import {
  SNAPSHOT_VERSION,
  SnapshotDecoder,
  type SnapshotMetadata,
} from '../../../shared/snapshotProtocol';
import {
  captureDiagnosticActorState,
  shouldSampleSnapshot,
} from '../../../shared/stateDiagnostics';
import type {
  AsteroidData,
  AsteroidDestroyEvent,
  AsteroidTaggedEvent,
  FurnaceDelivery,
  LootCollected,
  LootKind,
  PingMessage,
  PlayerJoin,
  PlayerLeave,
  PlayerUpdate,
  Position,
  SatellitePickupCollected,
  ServerGameSnapshot,
  ShockwaveEvent,
} from '../../../shared-types';
import { playDestructionSound } from '../../audio/destructionSounds';
import { playLaserSound } from '../../audio/gameSounds';
import {
  playAbilityActivation,
  playHarpoonLatch,
  playHarpoonRelease,
  playLootPickup,
  playOrbitalPickup,
} from '../../audio/interactionSounds';
import { withoutWorldAudio } from '../../audio/spatialAudio';
import { PALETTE, ROID } from '../../constants';
import { clientPerformance } from '../../diagnostics/performanceMetrics';
import { entityFactory } from '../../entities/EntityFactory';
import { AuthoritativeProjectileField } from '../../entities/laser/AuthoritativeProjectileField';
import type { Laser } from '../../entities/laser/Laser';
import { LootField } from '../../entities/loot/LootField';
import type { Player } from '../../entities/player/Player';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { SatellitePickupManager } from '../../entities/satellitePickup/SatellitePickupManager';
import { findHarpoonFieldBody, setHoldEmptyHarpoonField } from '../../entities/ship/harpoonField';
import { applyShipKitToShip, DEFAULT_SHIP_KIT_ID, getShipKit } from '../../entities/ship/shipKits';
import { shouldApplyDamagedHealth } from '../../entities/ship/shipUtils';
import { reconcilePlayerInput } from '../../input/keybindings';
import { applyTerrainSeed } from '../../physics/terrain/terrainSession';
import { getSelectedShipKitId } from '../../ui/shipKitSelect';
import { getClientReleaseId } from '../../utils/buildInfo';
import { setClientLogContext } from '../../utils/clientLogContext';
import { describeDeathCause } from '../../utils/deathCause';
import { logger } from '../../utils/Logger';
import type { ClientMessage } from '../types';
import {
  getCompletedSectors,
  resetWorldExploration,
  setCompletedSectors,
  setWorldExploration,
  setWorldMapAssets,
} from '../worldExploration';
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
  JOIN_COMPLETION_TIMEOUT_MS,
} from './connectionHealth';
import { nextReconnectDelayMs } from './connectionReconnect';
import { PlayerMotionReconciliation } from './PlayerMotionReconciliation';
import { PlayerListCache } from './playerListCache';
import { bindPageHideDisconnect, fillSnapshotEntityIds, isLocalGameEntity } from './playerPresence';
import {
  clearResumeCredential,
  isValidResumeToken,
  readStoredResumeProvenance,
  readStoredResumeToken,
  storeResumeCredential,
} from './resumeCredential';

interface ConnectionState {
  isConnected: boolean;
  socket: WebSocket | null;
}

interface ServerMessageEnvelope {
  readonly type: string;
  readonly data?: unknown;
  readonly timestamp?: unknown;
  readonly probeId?: unknown;
}

let nextConnectionId = 0;

function isServerMessageEnvelope(value: unknown): value is ServerMessageEnvelope {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

function isFinitePosition(value: unknown): value is Position {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    'x' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    'y' in value &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function isLootKind(value: unknown): value is LootKind {
  return value === 'shard' || value === 'wreckage' || value === 'laserCore';
}

function isLootCollectedEvent(value: unknown): value is LootCollected {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    'lootId' in value &&
    typeof value.lootId === 'string' &&
    value.lootId.length > 0 &&
    'collectorId' in value &&
    typeof value.collectorId === 'string' &&
    value.collectorId.length > 0 &&
    'kind' in value &&
    isLootKind(value.kind) &&
    'position' in value &&
    isFinitePosition(value.position)
  );
}

const MAX_PLAYED_LOOT_COLLECTION_IDS = 256;

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
  // A same-socket rejoin may receive already-queued current snapshots before
  // its new joined acknowledgment. This records the protocol established by
  // the prior acknowledgment without reopening compatibility fallback.
  private currentProtocolReady: boolean = false;
  private resumeToken?: string;
  private readonly motionReconciliation = new PlayerMotionReconciliation();
  private snapshotResyncPending: boolean = false;

  private clientId: string;
  private localPlayerName: string = '';
  private localPlayerId: string = '';
  private allPlayers: Map<string, Player> = new Map();
  private seenAsteroidIds: Set<string> = new Set(); // Track asteroids we've already seen
  private hasInitializedAsteroidsForConnection: boolean = false;
  private readonly playerListCache = new PlayerListCache<Player>();
  private readonly snapshotEntityIds = new Set<string>();
  private readonly taggedAsteroidIds = new Set<string>();
  private readonly playedLootCollectionIds = new Set<string>();
  private readonly asteroidScratch = createAsteroidFieldSyncScratch();
  private readonly pingPayload: PingMessage = { type: 'ping', timestamp: 0 };
  private readonly updateEnvelope: ClientMessage = {
    type: 'update',
    data: {} as PlayerUpdate,
    timestamp: 0,
  };

  // Heartbeat / half-open-socket detection (see connectionHealth.ts).
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerMessageAt = 0;
  private joinCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  private joinCompletionPending: boolean = false;
  private joinAcknowledged: boolean = false;
  private shotAcknowledgements: boolean = false;
  private joinWait?: { resolve: (ok: boolean) => void };

  // Only unexpected closes retry; terminal join failures already report an error.
  private disconnectReason: 'requested' | 'join-failed' | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnectedOnce: boolean = false;
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
    const storedResumeToken = readStoredResumeToken();
    if (storedResumeToken) {
      this.resumeToken = storedResumeToken;
    }
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
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }
    this.disconnectReason = null;
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
          clientPerformance.joinFailed();
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
        wsEndpoint.searchParams.set('snapshotVersion', String(SNAPSHOT_VERSION));
        wsEndpoint.searchParams.set('asteroidInteractions', '1');
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
          const receivedAt = Date.now();
          const acceptSnapshots = this.currentProtocolReady;
          this.lastServerMessageAt = receivedAt;
          const started = clientPerformance.enabled ? performance.now() : 0;
          let stateMetric: 'keyframeMessageMs' | 'deltaMessageMs' | undefined;
          try {
            const text: unknown = event.data;
            if (typeof text !== 'string') {
              throw new Error('Expected a text WebSocket message');
            }
            const result = this.snapshotDecoder.readMessage(
              text,
              { acceptSnapshots },
              clientPerformance.enabled
            );
            if (result.kind === 'message') {
              if (!isServerMessageEnvelope(result.message)) {
                throw new Error('Invalid server message envelope');
              }
              if (clientPerformance.enabled) {
                clientPerformance.message(result.message.type, text, started);
                if (result.timings) {
                  clientPerformance.record('parseMs', result.timings.parseMs);
                }
              }
              this.handleServerMessage(result.message);
              return;
            }
            if (clientPerformance.enabled) {
              clientPerformance.message('snapshot', text, started);
              if (result.timings) {
                clientPerformance.record('parseMs', result.timings.parseMs);
              }
              if (result.metadata) {
                stateMetric =
                  result.metadata.kind === 'keyframe' ? 'keyframeMessageMs' : 'deltaMessageMs';
              }
            }
            if (result.kind === 'snapshot-rejected') {
              this.requestSnapshotResync(result.error, result.metadata, receivedAt);
              return;
            }
            if (clientPerformance.enabled && result.timings?.decodeMs !== undefined) {
              clientPerformance.record(
                result.metadata.kind === 'keyframe' ? 'keyframeDecodeMs' : 'deltaDecodeMs',
                result.timings.decodeMs
              );
            }
            this.handleSnapshot(result.state, result.metadata, receivedAt);
          } catch (error) {
            logger.error(
              'NETWORK',
              'Failed to parse server message',
              error instanceof Error
                ? error
                : new Error(typeof error === 'string' ? error : JSON.stringify(error), {
                    cause: error,
                  })
            );
            clientPerformance.count('messageFailures');
          } finally {
            if (clientPerformance.enabled) {
              const elapsedMs = performance.now() - started;
              clientPerformance.record('messageMs', elapsedMs);
              if (stateMetric) {
                clientPerformance.record(stateMetric, elapsedMs);
              }
            }
          }
        };
      } catch (cause) {
        finish(
          cause instanceof Error
            ? cause
            : new Error(typeof cause === 'string' ? cause : JSON.stringify(cause), { cause })
        );
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
    this.motionReconciliation.transportClosed();
    const localShip = PlayerManager.getInstance().getLocalShip();
    if (localShip) {
      localShip.serverOwnsMotion = true;
    }
    this.resetSnapshotSession();
    this.state.isConnected = false;
    this.state.socket = null;
    this.stopHeartbeat();
    this.hasInitializedAsteroidsForConnection = false;
    // Preserve the visible belt while the next socket rejoins the authoritative world.
    setHoldEmptyHarpoonField(true);
    if (this.disconnectReason === null) {
      logger.warn('NETWORK', 'WebSocket connection closed');
    }
    logger.info('STATE', 'transport_closed', {
      closedAt: Date.now(),
      wasConnected,
      userRequested: this.disconnectReason === 'requested',
      reason: this.disconnectReason ?? 'unexpected',
      lastAcceptedSnapshotSequence,
      ...(serverReleaseId ? { serverReleaseId } : {}),
    });
    // Failed handshakes are retried by the awaiting reconnect attempt; only
    // a previously open transport starts a new retry sequence here.
    if (wasConnected && this.disconnectReason === null && this.hasConnectedOnce) {
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
        error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : JSON.stringify(error), { cause: error })
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
        error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : JSON.stringify(error), { cause: error })
      );
      this.retireSocket(socket);
      return false;
    }
  }

  disconnect(options?: { newSession?: boolean; reason?: 'requested' | 'join-failed' }): void {
    this.disconnectReason = options?.reason ?? 'requested';
    clientPerformance.joinFailed();
    clientPerformance.cancelRecovery();
    this.clearJoinCompletionTimer();
    this.cancelPendingConnect?.(new Error('WebSocket connection cancelled'));
    if (this.state.socket?.readyState === WebSocket.OPEN && this.joinAcknowledged) {
      this.sendPayload({ type: 'leave', data: {} });
    }
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    const socket = this.state.socket;
    if (socket) {
      this.retireSocket(socket);
    }
    this.motionReconciliation.reset();
    const localShip = PlayerManager.getInstance().getLocalShip();
    if (localShip) {
      localShip.serverOwnsMotion = false;
      delete localShip.playerMotion;
      delete localShip.laserUpgrade;
    }

    this.resetSnapshotSession();
    this.settleJoinWait(false);
    this.state.isConnected = false;
    this.state.socket = null;
    this.allPlayers.clear();
    this.taggedAsteroidIds.clear();
    this.playedLootCollectionIds.clear();
    this.playerListCache.invalidate();
    this.seenAsteroidIds.clear();
    this.hasInitializedAsteroidsForConnection = false;
    LootField.getInstance().clear();
    SatellitePickupManager.getInstance().clear();
    this.localPlayerId = '';
    this.lastDamageStateLogAt = 0;
    setClientLogContext({});
    // pagehide / unexpected close keep the stored id (#467). A new game may
    // still resume the private pilot credential so progress survives a return
    // to the menu or a kit change.
    this.hasConnectedOnce = false;
    if (options?.newSession) {
      this.clientId = replaceStoredClientId(
        typeof sessionStorage === 'undefined' ? null : sessionStorage
      );
      resetWorldExploration();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disconnectReason !== null || this.reconnectTimer !== null) {
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
        if (!this.state.socket && this.disconnectReason === null) {
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
    clientPerformance.clearProbes();
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearJoinCompletionTimer(): void {
    if (this.joinCompletionTimer !== null) {
      clearTimeout(this.joinCompletionTimer);
      this.joinCompletionTimer = null;
    }
    this.joinCompletionPending = false;
  }

  private settleJoinWait(ok: boolean): void {
    const wait = this.joinWait;
    delete this.joinWait;
    wait?.resolve(ok);
  }

  joinAndWaitForWorld(): Promise<boolean> {
    return new Promise((resolve) => {
      this.joinWait = { resolve };
      this.initializeAsteroidSync();
      if (!this.joinCompletionPending) {
        this.settleJoinWait(false);
      }
    });
  }

  private armJoinCompletionTimer(): void {
    this.clearJoinCompletionTimer();
    this.joinCompletionPending = true;
    this.joinAcknowledged = false;
    this.joinCompletionTimer = setTimeout(() => {
      if (!this.joinCompletionPending) {
        return;
      }
      this.failJoinCompletion(
        new Error('Timed out waiting for the joined acknowledgment and authoritative state')
      );
    }, JOIN_COMPLETION_TIMEOUT_MS);
  }

  private failJoinCompletion(error: Error, force = false): void {
    if (!force && !this.joinCompletionPending) {
      return;
    }
    this.clearJoinCompletionTimer();
    this.settleJoinWait(false);
    // Settle recovery before intentional teardown clears it. disconnect()
    // settles any pending join and leaves both methods idempotent when idle.
    clientPerformance.recoveryFailed();
    logger.error('NETWORK', 'Failed to complete server join', error);
    this.disconnect({ reason: 'join-failed' });
    window.dispatchEvent(
      new CustomEvent('networkPermanentlyDisconnected', {
        detail: { reason: 'Join did not complete' },
      })
    );
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
    this.pingPayload.probeId = clientPerformance.probe(performance.now());
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
    return localPlayer?.color ?? PALETTE.LOCAL;
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

    if (!this.joinAcknowledged) {
      return;
    }
    const ship = PlayerManager.getInstance().getLocalShip();
    if (!ship) {
      return;
    }
    const pose = this.motionReconciliation.buildHandoffPose(ship);
    if (pose) {
      Object.assign(playerState, pose);
    }
    if (!pose && this.motionReconciliation.shouldSuppressPose()) {
      return;
    }
    this.updateEnvelope.data = playerState;
    this.updateEnvelope.timestamp = Date.now();
    this.sendPayload(this.updateEnvelope);
  }

  // Send shoot event to server
  sendShootEvent(laser: Laser): void {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN ||
      !this.joinAcknowledged
    ) {
      logger.debug('NETWORK', 'Cannot send shoot event - current join is not acknowledged');
      return;
    }

    const ship = PlayerManager.getInstance().getLocalShip();
    if (!ship?.lasers.includes(laser)) {
      return;
    }
    const field = AuthoritativeProjectileField.getInstance();
    const requestId = this.shotAcknowledgements ? field.trackShot(ship, laser) : undefined;
    const message: ClientMessage = {
      type: 'shoot',
      id: this.localPlayerId || this.clientId,
      data: {
        laserStart: laser.position,
        laserDirection: laser.velocity,
        ...(requestId ? { requestId } : {}),
      },
      timestamp: Date.now(),
    };

    logger.debug('NETWORK', 'Sending shoot message to server', { playerId: message.id });
    if (!this.sendPayload(message) && requestId) {
      field.acknowledgeShot({ requestId, projectileId: null });
    }
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

    // Align local player id with join id before the first snapshot (avoids a
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
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
        clientReleaseId: getClientReleaseId(),
        ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
      },
      timestamp: Date.now(),
    };

    logger.debug('NETWORK', 'Sending join message', {
      id: this.clientId,
      resumable: Boolean(this.resumeToken),
      clientReleaseId: getClientReleaseId(),
      ...readStoredResumeProvenance(),
    });
    this.motionReconciliation.awaitAuthoritativePose();
    this.armJoinCompletionTimer();
    if (!this.sendPayload(joinMessage)) {
      this.failJoinCompletion(new Error('Failed to send join message'), true);
    }
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
    if (!this.joinAcknowledged) {
      return false;
    }
    if (!this.sendPayload(message)) {
      return false;
    }
    logger.debug('NETWORK', 'Sent message', {
      messageType: typeof message['type'] === 'string' ? message['type'] : 'unknown',
    });
    return true;
  }

  private handleServerMessage(message: ServerMessageEnvelope): void {
    const data = 'data' in message ? message.data : undefined;
    switch (message.type) {
      case 'pong':
        clientPerformance.pong(message.probeId, performance.now());
        return;
      case 'playerShotFired':
        if (
          data &&
          typeof data === 'object' &&
          'ownerId' in data &&
          typeof data.ownerId === 'string' &&
          data.ownerId !== PlayerManager.getInstance().getLocalPlayer()?.id &&
          'position' in data &&
          isFinitePosition(data.position)
        ) {
          playLaserSound(data.position);
        }
        break;
      case 'shotAcknowledged':
        if (
          data &&
          typeof data === 'object' &&
          'requestId' in data &&
          typeof data.requestId === 'string' &&
          'projectileId' in data &&
          (data.projectileId === null ||
            (typeof data.projectileId === 'string' && data.projectileId.length > 0))
        ) {
          AuthoritativeProjectileField.getInstance().acknowledgeShot({
            requestId: data.requestId,
            projectileId: data.projectileId,
          });
        }
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
        // The server explicitly rejected this credential; discard it so the
        // next menu join creates a fresh pilot instead of retrying forever.
        delete this.resumeToken;
        clearResumeCredential();
        this.motionReconciliation.reset();
        this.joinAcknowledged = false;
        this.currentProtocolReady = false;
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
      case 'satellitePickupCollected':
        this.handleSatellitePickupCollected(data as SatellitePickupCollected);
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
      case 'lootExploded':
        this.handleLootExploded(
          data as { lootId: string; position: Position; radius: number; shooterId: string }
        );
        break;
      case 'lootCollected':
        this.handleLootCollected(data);
        break;
      case 'furnaceDelivery':
        this.handleFurnaceDelivery(data as FurnaceDelivery);
        break;
      case 'abilityUsed':
        this.handleAbilityUsed(
          data as {
            id?: string;
            kitId?: string;
            abilityId?: string;
            harpoonTargetId?: string | null;
            harpoonLatchPos?: Position;

            abilityActiveFrames?: number;
          }
        );
        break;
      case 'error':
        if (this.joinCompletionPending && !this.joinAcknowledged) {
          const messageText = typeof data === 'string' ? data : 'Server rejected the join request';
          this.failJoinCompletion(new Error(messageText));
          break;
        }
        // Post-join command errors are expected to be reported without
        // tearing down an otherwise healthy gameplay session.
        logger.warn('NETWORK', 'Server error', { error: data });
        break;
      default:
        logger.debug('NETWORK', 'Unhandled server message type', { type: message.type });
    }
  }

  private resetSnapshotSession(): void {
    this.shotAcknowledgements = false;
    AuthoritativeProjectileField.getInstance().clear();
    this.clearJoinCompletionTimer();
    this.joinAcknowledged = false;
    this.snapshotDecoder.reset();
    clientPerformance.resetSnapshotWitness();
    this.currentProtocolReady = false;
    this.snapshotResyncPending = false;
    this.lastAcceptedSnapshotSequence = 0;
    delete this.serverReleaseId;
    clientPerformance.serverReleaseId = undefined;
  }

  private failCurrentProtocol(error: Error): void {
    this.clearJoinCompletionTimer();
    clientPerformance.recoveryFailed();
    logger.error('NETWORK', 'Current multiplayer protocol is required', error);
    this.disconnect({ reason: 'join-failed' });
    window.dispatchEvent(
      new CustomEvent('networkPermanentlyDisconnected', {
        detail: { reason: 'Current multiplayer protocol is required' },
      })
    );
  }

  private requestSnapshotResync(
    error: unknown,
    metadata?: SnapshotMetadata,
    receivedAt = Date.now()
  ): void {
    clientPerformance.count('messageFailures');
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
    if (!this.currentProtocolReady) {
      this.failCurrentProtocol(new Error('Snapshot arrived before the current protocol join ack'));
      return;
    }
    if (!this.snapshotResyncPending) {
      this.sendSnapshotResync();
    }
  }

  private sendSnapshotResync(): boolean {
    if (this.snapshotResyncPending) {
      return false;
    }
    const sent = this.sendMessage({ type: 'snapshotResync', data: {}, timestamp: Date.now() });
    if (sent) {
      this.snapshotResyncPending = true;
      clientPerformance.count('resyncs');
    }
    return sent;
  }

  private handleSnapshot(
    state: ServerGameSnapshot,
    metadata: SnapshotMetadata,
    receivedAt: number
  ): void {
    const sampled = shouldSampleSnapshot(metadata.sequence);
    const localBefore = sampled ? PlayerManager.getInstance().getLocalPlayer() : undefined;
    const clientBeforeApply = localBefore ? captureClientPlayerState(localBefore) : undefined;
    try {
      this.snapshotResyncPending = false;
      if (this.lastAcceptedSnapshotSequence === 0) {
        withoutWorldAudio(() => this.applyReceivedSnapshot(state));
      } else {
        this.applyReceivedSnapshot(state);
      }
      this.lastAcceptedSnapshotSequence = metadata.sequence;
      clientPerformance.snapshotApplied({
        sequence: metadata.sequence,
        kind: metadata.kind,
        gameTime: state.gameTime,
      });
      if (sampled) {
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
          ...(authoritative?.playerMotion
            ? {
                motionEpoch: authoritative.playerMotion.epoch,
                motionAck: authoritative.playerMotion.ack,
                motionMode: authoritative.playerMotion.mode,
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
      this.requestSnapshotResync(error, metadata, receivedAt);
    }
  }

  private applyReceivedSnapshot(data: ServerGameSnapshot): void {
    const localBefore = PlayerManager.getInstance().getLocalPlayer();
    const wasDead = Boolean(
      localBefore && (localBefore.ship.health <= 0 || localBefore.ship.exploding)
    );
    const applyStarted = clientPerformance.enabled ? performance.now() : 0;
    this.handleSnapshotState(data);
    const localStateApplied =
      (clientPerformance.enabled || this.joinCompletionPending) &&
      Boolean(
        this.localPlayerId &&
          PlayerManager.getInstance().getLocalPlayer() &&
          data.entities?.some((entity) => entity.id === this.localPlayerId)
      );
    if (clientPerformance.enabled) {
      clientPerformance.record('applyMs', performance.now() - applyStarted);
      if (localStateApplied) {
        clientPerformance.stateApplied();
      }
    }
    if (this.joinCompletionPending && this.joinAcknowledged && localStateApplied) {
      this.clearJoinCompletionTimer();
      this.settleJoinWait(true);
    }
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
    kitId?: unknown;
    abilityId?: unknown;
    harpoonTargetId?: string | null;
    harpoonLatchPos?: Position;

    abilityActiveFrames?: number;
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
    const abilityId = getShipKit(data.kitId ?? entity.ship.kitId).abilityId;
    const isHarpoonRelease = abilityId === 'harpoon' && data.harpoonTargetId === null;
    if (!isHarpoonRelease) {
      playAbilityActivation(abilityId, entity.ship.position);
    }
    if (abilityId === 'harpoon') {
      if (isHarpoonRelease) {
        playHarpoonRelease(entity.ship.position);
      } else {
        const targetPosition = isFinitePosition(data.harpoonLatchPos)
          ? data.harpoonLatchPos
          : typeof data.harpoonTargetId === 'string' && data.harpoonTargetId.length > 0
            ? findHarpoonFieldBody(data.harpoonTargetId)?.position
            : undefined;
        playHarpoonLatch(targetPosition ?? entity.ship.position);
      }
    }
    const latch = {
      ...(data.abilityActiveFrames !== undefined
        ? { abilityActiveFrames: data.abilityActiveFrames }
        : {}),
      ...(data.harpoonTargetId !== undefined ? { harpoonTargetId: data.harpoonTargetId } : {}),
      ...(data.harpoonLatchPos !== undefined ? { harpoonLatchPos: data.harpoonLatchPos } : {}),
    };
    entity.updateFromServer(latch);
    if (localPlayer && localPlayer !== entity && localPlayer.id === data.id) {
      localPlayer.updateFromServer(latch);
    }
  }

  private handleSnapshotState(data: ServerGameSnapshot): void {
    applyTerrainSeed(data.terrainSeed);
    setWorldMapAssets(data.mapAssets);
    setCompletedSectors(data.completedSectors);
    if (validExploration(data.exploration)) {
      setWorldExploration(data.exploration);
    }

    // Update local game state from server using unified entity system
    if (data.entities) {
      const localPlayer = PlayerManager.getInstance().getLocalPlayer();
      fillSnapshotEntityIds(data.entities, this.snapshotEntityIds);

      // Update entities in place so remotes stay attached across snapshots.
      for (const entityData of data.entities) {
        const isLocalPlayer = isLocalGameEntity(entityData, {
          clientId: this.clientId,
          localPlayerId: this.localPlayerId,
          localPlayerName: '',
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

          entity ??= entityFactory.createPlayer({
            id: entityData.id,
            name: entityData.name,
            type: 'remote',
            color: entityData.color,
            ...(entityData.kitId !== undefined ? { kitId: entityData.kitId } : {}),
            position: entityData.position,
          });

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
        // Kit / ability / deathCause / mass stay on the row.
        entityData.spawnProtectionTimer ??= 0;
        if (entityData.playerMotion !== undefined) {
          entity.ship.playerMotion = entityData.playerMotion;
        } else {
          delete entity.ship.playerMotion;
        }
        entity.name = entityData.name;
        if (entity.type !== 'local') {
          entityData.kitId ??= DEFAULT_SHIP_KIT_ID;
        }
        entity.ship.abilityCooldownFrames = entityData.abilityCooldownFrames ?? 0;
        entity.ship.abilityActiveFrames = entityData.abilityActiveFrames ?? 0;
        if (entityData.laserUpgrade) {
          entity.ship.laserUpgrade = { ...entityData.laserUpgrade };
        } else {
          delete entity.ship.laserUpgrade;
        }

        if (!entityData.deathCause && !entityData.exploding && entityData.health > 0) {
          delete entity.deathCause;
        }
        entity.updateFromServer(entityData);
        if (isLocalPlayer) {
          this.motionReconciliation.rebase(entityData, entity.ship, Date.now());
          entity.ship.serverOwnsMotion = this.motionReconciliation.shouldSuppressShipMove();
        }

        if (isLocalPlayer && entity.type === 'local') {
          // Snapshots echo older input. Reconcile every live control source after
          // authority and prediction, including death and respawn in either protocol.
          reconcilePlayerInput(entity);
        }

        if (isLocalPlayer && localPlayer && localPlayer !== entity) {
          localPlayer.updateFromServer(entityData);
        }
      }

      // Drop remotes that vanished from the snapshot so a closed tab leaves
      // the leaderboard even if `playerLeft` was missed.
      for (const [id, entity] of this.allPlayers) {
        if (entity.type !== 'local' && !this.snapshotEntityIds.has(id)) {
          this.forgetPlayer(id);
        }
      }
    }

    const localHull = PlayerManager.getInstance().getLocalPlayer()?.ship;
    if (localHull) {
      containBodyOutOfCompletedSectors(localHull, getCompletedSectors(), { radius: localHull.r });
    }

    // Apply the authoritative field: create unseen roids, then keep pose in sync
    // so late joiners and every client share the same moving asteroids.
    this.applyAuthoritativeAsteroids(data.asteroids, true);

    LootField.getInstance().applySnapshot(data.loot);
    SatellitePickupManager.getInstance().syncFromServer(data.satellitePickups);
    const projectileField = AuthoritativeProjectileField.getInstance();
    projectileField.sync(data.playerProjectiles);
    for (const player of this.allPlayers.values()) {
      projectileField.reconcileShip(player.ship, player.id);
    }
    const activeTags = new Set(data.collabTags.map((tag) => tag.asteroidId));
    for (const id of this.taggedAsteroidIds) {
      if (!activeTags.has(id)) {
        notifyAsteroidTagged({ asteroidId: id, shooterId: '', expiresAt: 0 });
      }
    }
    this.taggedAsteroidIds.clear();
    for (const tag of data.collabTags) {
      this.taggedAsteroidIds.add(tag.asteroidId);
      notifyAsteroidTagged({
        asteroidId: tag.asteroidId,
        shooterId: tag.hits[0]?.shooterId ?? '',
        expiresAt: tag.expiresAt,
      });
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
    if (isFinitePosition(data.position) && Number.isFinite(data.radius)) {
      playDestructionSound('loot', data.position);
      LootField.getInstance().noteBlast(data.position, data.radius);
    }
  }

  private handleLootCollected(data: unknown): void {
    if (!isLootCollectedEvent(data)) {
      return;
    }
    if (this.playedLootCollectionIds.has(data.lootId)) {
      return;
    }
    if (this.playedLootCollectionIds.size >= MAX_PLAYED_LOOT_COLLECTION_IDS) {
      const oldestId = this.playedLootCollectionIds.values().next().value;
      if (typeof oldestId === 'string') {
        this.playedLootCollectionIds.delete(oldestId);
      }
    }
    this.playedLootCollectionIds.add(data.lootId);
    playLootPickup(data.kind, data.position);
  }

  private handleFurnaceDelivery(data: FurnaceDelivery): void {
    if (!data?.furnaceId || !isFinitePosition(data.position)) {
      return;
    }
    window.dispatchEvent(new CustomEvent('furnaceDelivery', { detail: data }));
  }

  private applyAuthoritativeAsteroids(asteroids: AsteroidData[], complete = false): void {
    if (complete) {
      setHoldEmptyHarpoonField(false);
    }
    applyAsteroidFieldPartition(
      partitionAsteroidSnapshot(asteroids, this.seenAsteroidIds, this.asteroidScratch, complete),
      complete
    );
  }

  private handleJoined(data: PlayerJoin): void {
    AuthoritativeProjectileField.getInstance().clear();
    this.snapshotDecoder.reset();
    clientPerformance.resetSnapshotWitness();
    this.snapshotResyncPending = false;
    if (
      data.snapshotVersion !== SNAPSHOT_VERSION ||
      data.asteroidInteractions !== 1 ||
      !isValidResumeToken(data.resumeToken)
    ) {
      this.failCurrentProtocol(
        new Error('Joined acknowledgment is missing the current snapshot, motion, or resume token')
      );
      return;
    }
    this.joinAcknowledged = true;
    this.shotAcknowledgements = data.shotAcknowledgements === true;
    this.currentProtocolReady = true;
    this.resumeToken = data.resumeToken;
    storeResumeCredential(data.resumeToken, data.name, {
      ...releaseField('credentialReleaseId', data.credentialReleaseId ?? data.serverReleaseId),
      ...releaseField('scoreReleaseId', data.scoreReleaseId),
      ...releaseField('clientReleaseId', getClientReleaseId()),
    });
    if (data.serverReleaseId) {
      this.serverReleaseId = data.serverReleaseId;
      clientPerformance.serverReleaseId = data.serverReleaseId;
    } else {
      delete this.serverReleaseId;
      clientPerformance.serverReleaseId = undefined;
    }
    this.lastDamageStateLogAt = 0;
    setClientLogContext({ playerId: data.id, connectionId: this.connectionId });
    logger.info('STATE', 'player_joined', {
      joinedAt: Date.now(),
      playerId: data.id,
      asteroidInteractions: 1,
      snapshotVersion: SNAPSHOT_VERSION,
      ...(data.serverReleaseId ? { serverReleaseId: data.serverReleaseId } : {}),
      ...(data.credentialReleaseId ? { credentialReleaseId: data.credentialReleaseId } : {}),
      ...(data.credentialIssuedAt !== undefined
        ? { credentialIssuedAt: data.credentialIssuedAt }
        : {}),
      ...(data.scoreReleaseId ? { scoreReleaseId: data.scoreReleaseId } : {}),
      ...(data.scoreUpdatedAt !== undefined ? { scoreUpdatedAt: data.scoreUpdatedAt } : {}),
    });

    const keepField = shouldPreserveSeenAsteroidsOnJoin(this.seenAsteroidIds.size);
    if (!keepField) {
      this.seenAsteroidIds.clear();
      LootField.getInstance().clear();
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
      if (data.position) {
        localPlayer.ship.position.x = data.position.x;
        localPlayer.ship.position.y = data.position.y;
      }
      if (data.name) {
        localPlayer.name = data.name;
        this.localPlayerName = data.name;
      }
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
      const authoritativeKit = data.kitId ?? getSelectedShipKitId();
      if (localPlayer.ship.kitId !== authoritativeKit) {
        applyShipKitToShip(localPlayer.ship, authoritativeKit);
      }
    }
    this.initializeAsteroids();
  }

  private handlePlayerJoined(data: PlayerJoin): void {
    logger.info('NETWORK', 'Player joined', data as unknown as Record<string, unknown>);
    // Player handling is now done through unified entity system in handleSnapshotState
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

  private handleSatellitePickupCollected(data: SatellitePickupCollected): void {
    if (!data?.playerId || !data.pickupId) {
      return;
    }
    if (isFinitePosition(data.position)) {
      playOrbitalPickup(data.position);
    }
    window.dispatchEvent(new CustomEvent('satellitePickupCollected', { detail: data }));
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
      const deathCause = describeDeathCause(data.attackerId);
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
}
