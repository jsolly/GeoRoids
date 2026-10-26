import { releaseField } from '../../../shared/releaseId';
import { setScoutUtilityOnHost } from '../../../shared/shipAbilities';
import { applyShipKitToShip, DEFAULT_SHIP_KIT_ID } from '../../../shared/shipKits';
import { isTowCableUtility, scoutUtilityOf } from '../../../shared/shipUtilities';
import { isAsteroidDto, isLootKind } from '../../../shared/snapshotDto';
import {
  ASTEROID_INTERACTIONS_CAPABILITY,
  SNAPSHOT_VERSION,
  SnapshotDecoder,
  type SnapshotMetadata,
} from '../../../shared/snapshotProtocol';
import {
  boundedDiagnosticError,
  captureDiagnosticActorState,
} from '../../../shared/stateDiagnostics';
import { applyTerrainSeed } from '../../../shared/terrainField';
import type {
  AbilityUsedEvent,
  AsteroidData,
  AsteroidDestroyEvent,
  AsteroidHitEvent,
  ClientGameplayMessage,
  ClientWireMessage,
  FurnaceDelivery,
  LootCollected,
  PingMessage,
  PlayerJoin,
  PlayerLeave,
  PlayerUpdate,
  Position,
  SatellitePickupCollected,
  ServerGameSnapshot,
} from '../../../shared-types';
import { playDestructionSound } from '../../audio/destructionSounds';
import { playFeedback } from '../../audio/feedbackSounds';
import { playHitSound, playLaserSound } from '../../audio/gameSounds';
import {
  playAbilityActivation,
  playHarpoonRelease,
  playOrbitalPickup,
} from '../../audio/interactionSounds';
import { playLootPickup, playTapEjection, resetResourceMusic } from '../../audio/resourceMusic';
import { resetRouteMusic } from '../../audio/routeMusic';
import { stopSatelliteOrbit, syncSatelliteOrbit } from '../../audio/satelliteOrbitSound';
import { withoutWorldAudio } from '../../audio/spatialAudio';
import { GameStateManager } from '../../core/services/GameStateManager';
import {
  noteDebugPingSent,
  noteDebugPong,
  noteDebugSnapshot,
  resetDebugHudSession,
} from '../../diagnostics/debugHudMetrics';
import { clientPerformance } from '../../diagnostics/performanceMetrics';
import { AuthoritativeProjectileField } from '../../entities/laser/AuthoritativeProjectileField';
import type { Laser } from '../../entities/laser/Laser';
import { LootField } from '../../entities/loot/LootField';
import { createPlayer } from '../../entities/player/createPlayer';
import type { Player } from '../../entities/player/Player';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { SatellitePickupManager } from '../../entities/satellitePickup/SatellitePickupManager';
import { setHoldEmptyHarpoonField } from '../../entities/ship/harpoonField';
import type { ShipCombatNetwork } from '../../entities/ship/shipCombatNetwork';
import { shouldApplyDamagedHealth } from '../../entities/ship/shipUtils';
import { playLocalHaptic } from '../../fx/haptics';
import { reconcilePlayerInput } from '../../input/keybindings';
import { setSettlement } from '../../network/worldExploration';
import { setContourBridges } from '../../physics/terrain/contourBridgeSession';
import { setRolyPolys } from '../../physics/terrain/rolyPolySession';
import { setSpiderField } from '../../physics/terrain/spiderSession';
import { setBeltRecovery } from '../../rendering/beltRenderer';
import { getSelectedShipKitId } from '../../runtime/shipSelection';
import { getClientReleaseId } from '../../utils/buildInfo';
import { setClientLogContext } from '../../utils/clientLogContext';
import { logger } from '../../utils/Logger';
import { setWorldCampaign } from '../worldCampaign';
import {
  resetWorldExploration,
  setWorldExploration,
  setWorldMapAssets,
  worldFurnaces,
} from '../worldExploration';
import {
  applyAsteroidFieldPartition,
  createAsteroidFieldSyncScratch,
  notifyAsteroidDestroyed,
  partitionAsteroidSnapshot,
  readAsteroidBelt,
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
import { publishPlayerIdentity } from './playerIdentityEvents';
import { PlayerListCache } from './playerListCache';
import {
  bindPageHideDisconnect,
  fillSnapshotEntityIds,
  isLocalGameEntity,
  pruneStaleRemotePlayers,
} from './playerPresence';
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

function isLootCollectedEvent(value: unknown): value is LootCollected {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    (!('eventId' in value) ||
      (typeof value.eventId === 'string' &&
        value.eventId.length > 0 &&
        value.eventId.length <= 128)) &&
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

const MAX_PLAYED_EVENT_IDS = 256;

function rememberOnce(ids: Set<string>, id: string): boolean {
  if (ids.has(id)) {
    return false;
  }
  if (ids.size >= MAX_PLAYED_EVENT_IDS) {
    const oldest = ids.values().next().value;
    if (oldest !== undefined) {
      ids.delete(oldest);
    }
  }
  ids.add(id);
  return true;
}

function captureClientPlayerState(player: Player) {
  return captureDiagnosticActorState({
    position: player.ship.position,
    velocity: player.ship.velocity,
    angle: player.ship.angle,
    health: player.ship.health,
    maxHealth: player.ship.maxHealth,
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
  private chargedWeapons = false;
  private resumeToken?: string;
  private readonly motionReconciliation = new PlayerMotionReconciliation();
  private snapshotResyncPending: boolean = false;

  private clientId: string;
  private localPlayerName: string = '';
  private localPlayerId: string = '';
  private allPlayers: Map<string, Player> = new Map();
  private readonly playerListCache = new PlayerListCache<Player>();
  private readonly snapshotEntityIds = new Set<string>();
  private cargoDepositBaseline: { cargo: number; banked: number } | null = null;
  private readonly playedLootCollectionIds = new Set<string>();
  private readonly playedTapEjectionIds = new Set<string>();
  private readonly playedLootExplosionIds = new Set<string>();
  private readonly asteroidScratch = createAsteroidFieldSyncScratch();
  private readonly pingPayload: PingMessage = { type: 'ping' };
  private readonly updateEnvelope: Extract<ClientWireMessage, { type: 'update' }> = {
    type: 'update',
    data: {} as PlayerUpdate,
  };

  // Heartbeat / half-open-socket detection (see connectionHealth.ts).
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerMessageAt = 0;
  private joinCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  private joinCompletionPending: boolean = false;
  private joinAcknowledged: boolean = false;
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

  readonly combatNetwork: ShipCombatNetwork;

  private constructor() {
    const connection = this;
    this.combatNetwork = {
      get isConnected() {
        return connection.isConnected;
      },
      sendCharge: (action) =>
        this.chargedWeapons &&
        this.joinAcknowledged &&
        this.sendMessage({ type: 'chargeWeapon', id: this.getLocalPlayerId(), data: { action } }),
      sendShoot: (laser) => this.sendShootEvent(laser),
      sendAbility: () =>
        this.sendMessage({ type: 'useAbility', id: this.getLocalPlayerId(), data: {} }),
    };
    this.state = {
      isConnected: false,
      socket: null,
    };
    this.clientId = readOrCreateClientId(
      typeof sessionStorage === 'undefined' ? null : sessionStorage
    );
    const storedResumeToken = readStoredResumeToken();
    if (storedResumeToken != null && storedResumeToken !== '') {
      this.resumeToken = storedResumeToken;
    }
  }

  /** The mounted browser runtime owns tab-close/bfcache socket cleanup. */
  attachRuntime(signal: AbortSignal): void {
    bindPageHideDisconnect(() => this.disconnect(), signal);
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

  get isConnected(): boolean {
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
        wsEndpoint.searchParams.set(
          'asteroidInteractions',
          String(ASTEROID_INTERACTIONS_CAPABILITY)
        );
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
              const message = result.message;
              // Events queued before this pilot joined may precede the baseline.
              // Apply their state, but do not announce a world not yet received.
              if (this.lastAcceptedSnapshotSequence === 0 && message.type !== 'error') {
                withoutWorldAudio(() => this.handleServerMessage(message));
              } else {
                this.handleServerMessage(message);
              }
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
              boundedDiagnosticError(error, 'Unknown server message failure')
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
        finish(boundedDiagnosticError(cause, 'Unknown WebSocket setup failure'));
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
      localShip.releaseContourLock();
      localShip.finishWeaponCharge(false);
      localShip.serverOwnsMotion = true;
    }
    this.resetSnapshotSession();
    this.state.isConnected = false;
    this.state.socket = null;
    this.stopHeartbeat();
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
      ...(serverReleaseId != null && serverReleaseId !== '' ? { serverReleaseId } : {}),
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
        boundedDiagnosticError(error, 'Unknown WebSocket close failure')
      );
    }
  }

  /** A failed send invalidates the transport; commands are never silently queued. */
  private sendPayload(message: ClientWireMessage): boolean {
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
        boundedDiagnosticError(error, 'Unknown WebSocket send failure')
      );
      this.retireSocket(socket);
      return false;
    }
  }

  disconnect(options?: { newSession?: boolean; reason?: 'requested' | 'join-failed' }): void {
    this.disconnectReason = options?.reason ?? 'requested';
    setWorldCampaign();
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
      localShip.furnaceTransit = null;
    }

    this.resetSnapshotSession();
    this.settleJoinWait(false);
    this.state.isConnected = false;
    this.state.socket = null;
    this.allPlayers.clear();
    this.playerListCache.invalidate();
    this.applyAuthoritativeAsteroids([], true);
    LootField.getInstance().clear();
    SatellitePickupManager.getInstance().clear();
    this.localPlayerId = '';
    this.lastDamageStateLogAt = 0;
    setClientLogContext({});
    // pagehide / unexpected close keep the stored id (#467). A new game may
    // still resume the private pilot credential so progress survives a return
    // to the menu or a kit change.
    this.hasConnectedOnce = false;
    if (options?.newSession === true) {
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

    const pingNow = performance.now();
    const probeId = clientPerformance.probe(pingNow);
    this.pingPayload.probeId = probeId;
    if (!this.sendPayload(this.pingPayload)) {
      return;
    }
    noteDebugPingSent(probeId, pingNow);

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

  getServerReleaseId(): string | undefined {
    return this.serverReleaseId;
  }

  getLocalPlayerId(): string {
    // Join uses clientId until the server `joined` echo sets localPlayerId (same value).
    return this.localPlayerId || this.clientId;
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

  updatePlayerState(state: Omit<PlayerUpdate, 'id'>): void {
    this.sendPlayerState({ id: this.getLocalPlayerId(), ...state });
  }

  // Send player state to server
  sendPlayerState(playerState: PlayerUpdate): boolean {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    if (!this.joinAcknowledged) {
      return false;
    }
    const ship = PlayerManager.getInstance().getLocalShip();
    if (!ship || ship.furnaceTransit) {
      return false;
    }
    const pose = this.motionReconciliation.buildHandoffPose(ship);
    if (pose) {
      Object.assign(playerState, pose);
    }
    if (!pose && this.motionReconciliation.shouldSuppressPose()) {
      return false;
    }
    this.updateEnvelope.data = playerState;
    return this.sendPayload(this.updateEnvelope);
  }

  // Send shoot event to server
  sendShootEvent(laser: Laser): void {
    if (
      !this.state.isConnected ||
      !this.state.socket ||
      this.state.socket.readyState !== WebSocket.OPEN ||
      !this.joinAcknowledged
    ) {
      return;
    }

    const player = PlayerManager.getInstance().getLocalPlayer();
    const ship = player?.ship;
    if (
      !player ||
      !this.localPlayerId ||
      player.id !== this.localPlayerId ||
      !ship?.lasers.includes(laser) ||
      ship.exploding ||
      ship.health <= 0
    ) {
      return;
    }
    // The shot budget uses the authoritative pose. Keep its current handoff
    // immediately ahead of the shot on this socket, using the normal allocator.
    if (!this.sendPlayerState({ id: this.localPlayerId, ...player.getStateForNetwork() })) {
      return;
    }
    const field = AuthoritativeProjectileField.getInstance();
    const requestId = field.trackShot(ship, laser);
    const message: Extract<ClientWireMessage, { type: 'shoot' }> = {
      type: 'shoot',
      id: this.localPlayerId || this.clientId,
      data: {
        laserStart: laser.position,
        laserDirection: laser.velocity,
        requestId,
      },
    };

    if (!this.sendPayload(message)) {
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
    const joinMessage: Extract<ClientWireMessage, { type: 'join' }> = {
      type: 'join',
      id: this.clientId,
      data: {
        name: this.localPlayerName,
        position: playerPosition,
        kitId: localPlayer?.ship.kitId ?? getSelectedShipKitId(),
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: ASTEROID_INTERACTIONS_CAPABILITY,
        cooperativeVersion: 1,
        worldRemains: 1,

        clientReleaseId: getClientReleaseId(),
        ...(this.resumeToken != null && this.resumeToken !== ''
          ? { resumeToken: this.resumeToken }
          : {}),
      },
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

  sendMessage(message: ClientGameplayMessage): boolean {
    if (!this.joinAcknowledged) {
      return false;
    }
    if (!this.sendPayload(message)) {
      return false;
    }

    return true;
  }

  private handleServerMessage(message: ServerMessageEnvelope): void {
    const data = 'data' in message ? message.data : undefined;
    switch (message.type) {
      case 'pong': {
        const now = performance.now();
        clientPerformance.pong(message.probeId, now);
        noteDebugPong(message.probeId, now);
        return;
      }
      case 'playerShotFired':
        if (
          data !== null &&
          typeof data === 'object' &&
          'ownerId' in data &&
          typeof data.ownerId === 'string' &&
          (data.ownerId !== PlayerManager.getInstance().getLocalPlayer()?.id ||
            ('charged' in data && data.charged === true)) &&
          'position' in data &&
          isFinitePosition(data.position)
        ) {
          playLaserSound(data.position);
          if ('charged' in data && data.charged === true) {
            playLocalHaptic(data.ownerId === this.getLocalPlayerId(), 'shot');
          }
        }
        break;
      case 'shotAcknowledged':
        if (
          data !== null &&
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
        setSpiderField(undefined);
        setWorldCampaign();
        setRolyPolys();
        setContourBridges();
        resetRouteMusic();
        setBeltRecovery();
        // Remove the previous map key before initializeAsteroidSync changes
        // the local Player object's id for the replacement session.
        const localPlayer = PlayerManager.getInstance().getLocalPlayer();
        if (localPlayer?.id != null && localPlayer?.id !== '') {
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
        this.chargedWeapons = false;
        this.clientId = replaceStoredClientId();
        this.initializeAsteroidSync();
        break;
      }
      case 'joined':
        this.handleJoined(data as PlayerJoin);
        break;
      case 'playerLeft':
        this.handlePlayerLeft(data as PlayerLeave);
        break;
      case 'asteroidCreateBatch':
        this.handleAsteroidCreateBatch(data as { asteroids: AsteroidData[] });
        break;
      case 'asteroidDestroy':
        this.handleAsteroidDestroyed(data as AsteroidDestroyEvent);
        break;
      case 'asteroidHit':
        this.handleAsteroidHit(data as AsteroidHitEvent);
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
      case 'tapEjected':
        this.handleTapEjected(data);
        break;
      case 'furnaceBuildResult':
        if (typeof data === 'string') {
          GameStateManager.getInstance().setNotice(data);
        }
        break;
      case 'furnaceTravelResult':
        window.dispatchEvent(new CustomEvent('furnaceTravelResult', { detail: data }));
        break;
      case 'townStoreResult':
        window.dispatchEvent(new CustomEvent('townStoreResult', { detail: data }));
        break;
      case 'furnaceDelivery':
        this.handleFurnaceDelivery(data as FurnaceDelivery);
        break;
      case 'abilityUsed':
        this.handleAbilityUsed(data as AbilityUsedEvent);
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
    resetResourceMusic();
    stopSatelliteOrbit();
    this.playedLootCollectionIds.clear();
    this.playedTapEjectionIds.clear();
    this.playedLootExplosionIds.clear();
    setSpiderField(undefined);
    setRolyPolys();
    setContourBridges();
    resetRouteMusic();
    setBeltRecovery();
    AuthoritativeProjectileField.getInstance().clear();
    this.clearJoinCompletionTimer();
    this.joinAcknowledged = false;
    this.snapshotDecoder.reset();
    this.cargoDepositBaseline = null;
    clientPerformance.resetSnapshotWitness();
    this.currentProtocolReady = false;
    this.chargedWeapons = false;
    this.snapshotResyncPending = false;
    this.lastAcceptedSnapshotSequence = 0;
    delete this.serverReleaseId;
    resetDebugHudSession();
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
        ...(this.serverReleaseId != null && this.serverReleaseId !== ''
          ? { serverReleaseId: this.serverReleaseId }
          : {}),
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

  sendSnapshotResync(): boolean {
    if (!this.currentProtocolReady || this.snapshotResyncPending) {
      return false;
    }
    // A rejected world queued before same-socket rejoin must be able to
    // request recovery while the new join keeps gameplay commands gated.
    const sent = this.sendPayload({ type: 'snapshotResync', data: {} });
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
    const appliedSocket = this.state.socket;
    try {
      this.snapshotResyncPending = false;
      if (this.lastAcceptedSnapshotSequence === 0) {
        withoutWorldAudio(() => this.applyReceivedSnapshot(state));
      } else {
        this.applyReceivedSnapshot(state);
      }
      this.lastAcceptedSnapshotSequence = metadata.sequence;
      // TCP acceptance cannot prove the world was applied. Release the server's
      // bounded pipeline only after all snapshot consumers completed above.
      if (appliedSocket && this.state.socket === appliedSocket && this.currentProtocolReady) {
        // Ordered old-session worlds can arrive while this socket's rejoin is
        // awaiting joined. Their receipts must drain preserved transport debt
        // even while gameplay commands remain gated by joinAcknowledged.
        this.sendPayload({ type: 'snapshotAck', data: { sequence: metadata.sequence } });
      }
      noteDebugSnapshot(metadata.sequence, performance.now());
      clientPerformance.snapshotApplied({
        ownerId: this.getLocalPlayerId(),
        sequence: metadata.sequence,
        kind: metadata.kind,
        gameTime: state.gameTime,
        serverTime: state.serverTime,
      });
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
        ...(this.serverReleaseId != null && this.serverReleaseId !== ''
          ? { serverReleaseId: this.serverReleaseId }
          : {}),
      });
    }
  }

  private handleAbilityUsed(data: AbilityUsedEvent): void {
    if (!data.id) {
      return;
    }
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    const entity =
      this.allPlayers.get(data.id) ?? (localPlayer?.id === data.id ? localPlayer : undefined);
    if (!entity) {
      return;
    }
    const abilityId = data.abilityId;
    const isHarpoonRelease =
      abilityId === 'harpoon' &&
      data.harpoonTargetId === null &&
      data.utilityFlight?.phase !== 'outbound';
    const isLocalAbility =
      data.id === localPlayer?.id || data.id === this.getLocalPlayerId() || entity.type === 'local';
    if (!isHarpoonRelease) {
      // Tow cues follow authoritative state transitions in Player, shared by
      // ability events and snapshots. Other tools keep their activation cue.
      if (abilityId !== 'harpoon' || !isTowCableUtility(entity.ship)) {
        playAbilityActivation(abilityId, entity.ship.position);
      }
      playLocalHaptic(isLocalAbility, 'ability');
    }
    if (
      isHarpoonRelease &&
      !isTowCableUtility(entity.ship) &&
      (entity.ship.harpoonTargetId == null || entity.ship.harpoonTargetId === '')
    ) {
      playHarpoonRelease(entity.ship.position);
    }
    if (
      abilityId === 'harpoon' &&
      isHarpoonRelease &&
      isFinitePosition(data.boostIgnitionPosition)
    ) {
      playFeedback('boostIgnite', data.boostIgnitionPosition);
      playLocalHaptic(isLocalAbility, 'asteroidIgnition');
    }
    const latch = {
      ...(data.utilityFlight !== undefined ? { utilityFlight: data.utilityFlight } : {}),
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
    setWorldCampaign(data.cooperativeActive, data.campaign);
    setSpiderField(data.spiderField);
    setRolyPolys(data.rolyPolys);
    setContourBridges(data.contourBridges);
    setBeltRecovery(data.beltRecovery);
    applyTerrainSeed(data.terrainSeed);
    setWorldMapAssets(data.mapAssets);
    setSettlement(data.settlement);
    worldFurnaces.replaceLit(data.civicModules);
    setWorldExploration(data.exploration);

    // Update local game state from server using unified entity system
    if (data.entities != null) {
      const localPlayer = PlayerManager.getInstance().getLocalPlayer();
      fillSnapshotEntityIds(data.entities, this.snapshotEntityIds);

      // Update entities in place so remotes stay attached across snapshots.
      for (const entityData of data.entities) {
        const isLocalPlayer = isLocalGameEntity(entityData, {
          clientId: this.clientId,
          localPlayerId: this.localPlayerId,
        });

        let entity = this.allPlayers.get(entityData.id);

        if (!entity) {
          if (isLocalPlayer) {
            // Adopt the game-loop's local player as the single source of truth
            // for the local ship, so server-authoritative state (health, score,
            // cargo, respawn) flows into the same object the game loop renders,
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

          entity ??= createPlayer({
            combatNetwork: this.combatNetwork,
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
        // Kit / ability / mass stay on the row.
        entityData.spawnProtectionTimer ??= 0;
        entityData.weaponChargeFrames ??= 0;
        entityData.navigationAssistFrames ??= 0;
        entityData.contourDraftFrames ??= 0;
        if (entityData.playerMotion !== undefined) {
          entity.ship.playerMotion = entityData.playerMotion;
        } else {
          delete entity.ship.playerMotion;
        }
        entity.name = entityData.name;
        if (entityData.botRole) {
          entity.botRole = entityData.botRole;
        } else {
          delete entity.botRole;
        }
        if (entity.type !== 'local') {
          entityData.kitId ??= DEFAULT_SHIP_KIT_ID;
        }
        const snapshotUtility =
          entity.type === 'local'
            ? scoutUtilityOf(entity.ship)
            : (entityData.scoutUtility ?? scoutUtilityOf(entity.ship));
        const scoutToolSelected =
          entity.ship.kitId === 'scout' && snapshotUtility !== 'mineral_scan';
        const serverCooldown = entityData.abilityCooldownFrames ?? 0;
        // Mineral Scan predicts its timers on send. A snapshot that still
        // reads 0 must not reverse its camera before the server echo. Death
        // and the first live echo after death always accept authority. Failed
        // probe launches and furnace builds stay at 0 and remain usable.
        if (
          entity.type !== 'local' ||
          entity.ship.kitId !== 'scout' ||
          scoutToolSelected ||
          entityData.health <= 0 ||
          entityData.exploding ||
          entity.ship.health <= 0 ||
          entity.ship.exploding ||
          serverCooldown > 0 ||
          entity.ship.abilityCooldownFrames <= 0
        ) {
          entity.ship.abilityCooldownFrames = serverCooldown;
          entity.ship.abilityActiveFrames = scoutToolSelected
            ? 0
            : (entityData.abilityActiveFrames ?? 0);
        }

        entity.ship.furnaceClockOffsetMs = data.serverTime - Date.now();
        if (isLocalPlayer && entityData.bankedCargo !== undefined) {
          const previous = this.cargoDepositBaseline;
          const banked = entityData.bankedCargo;
          const cargo = entityData.cargo;
          if (
            previous &&
            previous.cargo > 0 &&
            cargo === 0 &&
            banked - previous.banked >= previous.cargo &&
            entityData.health > 0 &&
            !entityData.exploding
          ) {
            playFeedback('delivery');
          }
          this.cargoDepositBaseline = { cargo, banked };
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
      }

      if (pruneStaleRemotePlayers(this.allPlayers, this.snapshotEntityIds) > 0) {
        this.playerListCache.invalidate();
      }
    }

    // Apply the authoritative field: create unseen roids, then keep pose in sync
    // so late joiners and every client share the same moving asteroids.
    this.applyAuthoritativeAsteroids(data.asteroids, true);

    LootField.getInstance().applySnapshot(data.loot);
    SatellitePickupManager.getInstance().syncFromServer(data.satellitePickups);
    syncSatelliteOrbit(
      data.satellitePickups.find(
        (pickup) => pickup.ownerId === this.localPlayerId && pickup.state === 'orbiting'
      )
    );
    const projectileField = AuthoritativeProjectileField.getInstance();
    projectileField.sync(data.playerProjectiles);
    for (const player of this.allPlayers.values()) {
      projectileField.reconcileShip(player.ship, player.id);
    }
  }

  private handleLootExploded(data: {
    lootId: string;
    position: Position;
    radius: number;
    shooterId: string;
  }): void {
    if (
      !data.lootId ||
      !isFinitePosition(data.position) ||
      !Number.isFinite(data.radius) ||
      !rememberOnce(this.playedLootExplosionIds, data.lootId)
    ) {
      return;
    }

    LootField.getInstance().remove(data.lootId);
    playDestructionSound('loot', data.position);
    LootField.getInstance().noteBlast(data.position, data.radius);
  }

  private handleTapEjected(data: unknown): void {
    if (
      typeof data !== 'object' ||
      data === null ||
      Array.isArray(data) ||
      !('lootId' in data) ||
      typeof data.lootId !== 'string' ||
      !data.lootId ||
      !('position' in data) ||
      !isFinitePosition(data.position)
    ) {
      return;
    }
    if (!rememberOnce(this.playedTapEjectionIds, data.lootId)) {
      return;
    }

    playTapEjection(data.position);
  }

  private handleLootCollected(data: unknown): void {
    if (!isLootCollectedEvent(data)) {
      return;
    }
    const isLocal = data.collectorId === this.getLocalPlayerId();
    const collectionId = data.eventId
      ? `event:${data.eventId}`
      : `legacy:${data.lootId}:${data.collectorId}`;
    if (!rememberOnce(this.playedLootCollectionIds, collectionId)) {
      return;
    }

    playLootPickup(data.position);
    playLocalHaptic(isLocal, 'pickup');
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
      partitionAsteroidSnapshot(asteroids, readAsteroidBelt(), this.asteroidScratch, complete)
    );
  }

  private handleJoined(data: PlayerJoin): void {
    AuthoritativeProjectileField.getInstance().clear();
    this.snapshotDecoder.reset();
    this.cargoDepositBaseline = null;
    clientPerformance.resetSnapshotWitness();
    this.snapshotResyncPending = false;
    if (
      data.snapshotVersion !== SNAPSHOT_VERSION ||
      data.asteroidInteractions !== ASTEROID_INTERACTIONS_CAPABILITY ||
      !isValidResumeToken(data.resumeToken) ||
      !Number.isFinite(data.terrainSeed)
    ) {
      this.failCurrentProtocol(
        new Error(
          'Joined acknowledgment is missing the current snapshot, motion, resume token, or terrain seed'
        )
      );
      return;
    }
    // A restored pilot keeps its ID but starts a new motion epoch. The joined
    // acknowledgment is the boundary after which old movement counters expire.
    this.motionReconciliation.reset();
    this.motionReconciliation.awaitAuthoritativePose();
    this.joinAcknowledged = true;
    this.chargedWeapons = data.chargedWeapons === 1;
    this.currentProtocolReady = true;
    this.resumeToken = data.resumeToken;
    storeResumeCredential(data.resumeToken, data.name, {
      ...releaseField('credentialReleaseId', data.credentialReleaseId ?? data.serverReleaseId),
      ...releaseField('scoreReleaseId', data.scoreReleaseId),
      ...releaseField('clientReleaseId', getClientReleaseId()),
    });
    if (data.serverReleaseId != null && data.serverReleaseId !== '') {
      this.serverReleaseId = data.serverReleaseId;
    } else {
      delete this.serverReleaseId;
    }
    this.lastDamageStateLogAt = 0;
    setClientLogContext({ playerId: data.id, connectionId: this.connectionId });
    publishPlayerIdentity(data.id);
    logger.info('STATE', 'player_joined', {
      joinedAt: Date.now(),
      playerId: data.id,
      snapshotVersion: SNAPSHOT_VERSION,
      ...(data.serverReleaseId != null && data.serverReleaseId !== ''
        ? { serverReleaseId: data.serverReleaseId }
        : {}),
      ...(data.credentialReleaseId != null && data.credentialReleaseId !== ''
        ? { credentialReleaseId: data.credentialReleaseId }
        : {}),
      ...(data.credentialIssuedAt !== undefined
        ? { credentialIssuedAt: data.credentialIssuedAt }
        : {}),
      ...(data.scoreReleaseId != null && data.scoreReleaseId !== ''
        ? { scoreReleaseId: data.scoreReleaseId }
        : {}),
      ...(data.scoreUpdatedAt !== undefined ? { scoreUpdatedAt: data.scoreUpdatedAt } : {}),
    });

    const keepField = readAsteroidBelt().length > 0;
    if (!keepField) {
      LootField.getInstance().clear();
      SatellitePickupManager.getInstance().clear();
    }
    // Keep the warm belt until the first authoritative snapshot replaces it.

    applyTerrainSeed(data.terrainSeed);

    // Store the local player ID from server response
    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    if (localPlayer) {
      localPlayer.resetCombatLifecycle();
      if (data.position != null) {
        localPlayer.ship.position.x = data.position.x;
        localPlayer.ship.position.y = data.position.y;
      }
      if (data.name) {
        localPlayer.name = data.name;
        this.localPlayerName = data.name;
      }
    }
    if (data.id) {
      if (localPlayer?.id != null && localPlayer?.id !== '' && localPlayer.id !== data.id) {
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
      if (localPlayer.ship.kitId === 'hauler') {
        const utility = 'tow_cable';
        localPlayer.ship.haulerUtility = utility;
        this.sendMessage({
          type: 'setHaulerUtility',
          id: localPlayer.id,
          data: { utilityId: utility },
        });
      }
      if (localPlayer.ship.kitId === 'scout') {
        const utility = 'mineral_scan';
        setScoutUtilityOnHost(localPlayer.ship, utility);
        this.sendMessage({
          type: 'setScoutUtility',
          id: localPlayer.id,
          data: { utilityId: utility },
        });
      }
    }
  }

  private handlePlayerLeft(data: PlayerLeave): void {
    logger.info('NETWORK', 'Player left', data as unknown as Record<string, unknown>);
    if (data.id) {
      this.forgetPlayer(data.id);
    }
  }

  private handleAsteroidCreateBatch(data: { asteroids?: unknown }): void {
    if (!Array.isArray(data.asteroids)) {
      return;
    }
    const valid: AsteroidData[] = [];
    for (const row of data.asteroids) {
      if (isAsteroidDto(row)) {
        valid.push(row);
      } else {
        logger.error('NETWORK', 'Rejected invalid asteroid create row', undefined, {
          asteroidId:
            row && typeof row === 'object' && typeof row.id === 'string' ? row.id : '<unknown>',
        });
      }
    }
    this.applyAuthoritativeAsteroids(valid);
  }

  private handleAsteroidDestroyed(data: AsteroidDestroyEvent): void {
    notifyAsteroidDestroyed({
      asteroidId: data.asteroidId,
      ...(data.origin !== undefined ? { origin: data.origin } : {}),
      ...(data.consumedBy === 'furnace' ? { consumedBy: 'furnace' as const } : {}),
    });
  }

  /** A durable deposit took a chip; its shatter plays a destruction sound instead. */
  private handleAsteroidHit(data: AsteroidHitEvent): void {
    if (!data?.asteroidId || !isFinitePosition(data.position)) {
      return;
    }
    playHitSound(data.position);
  }

  private handleSatellitePickupCollected(data: SatellitePickupCollected): void {
    if (!data?.playerId || !data.pickupId) {
      return;
    }
    if (isFinitePosition(data.position)) {
      playOrbitalPickup(data.position);
    }
    playLocalHaptic(data.playerId === this.getLocalPlayerId(), 'pickup');
    window.dispatchEvent(new CustomEvent('satellitePickupCollected', { detail: data }));
  }

  private handlePlayerDamaged(data: {
    targetPlayerId: string;
    attackerId: string;
    damage: number;
    remainingHealth: number;
    isDestroyed: boolean;
  }): void {
    logger.debug('NETWORK', 'Player damaged', {
      targetPlayerId: data.targetPlayerId,
      attackerId: data.attackerId,
      damage: data.damage,
      remainingHealth: data.remainingHealth,
      isDestroyed: data.isDestroyed,
    });

    const localPlayer = PlayerManager.getInstance().getLocalPlayer();
    const isLocalTarget = Boolean(
      localPlayer &&
        (localPlayer.id === data.targetPlayerId || this.getLocalPlayerId() === data.targetPlayerId)
    );
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

    this.applyDamageToLocalPlayerIfTarget(data);

    this.applyAuthoritativeDamageHealth(targetPlayer, data.remainingHealth, data.isDestroyed);

    if (data.remainingHealth > 0 && data.damage > 0) {
      targetPlayer.ship.takeDamage(0);
      if (isLocalTarget && beforeHealth !== undefined && data.remainingHealth < beforeHealth) {
        playFeedback('hullDamage');
        playLocalHaptic(true, 'hit');
      }
    }

    if (data.isDestroyed && !targetPlayer.ship.exploding) {
      targetPlayer.ship.explode();
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
          ...(this.serverReleaseId != null && this.serverReleaseId !== ''
            ? { serverReleaseId: this.serverReleaseId }
            : {}),
        });
      }
    }
  }

  /** Keep PlayerManager's local ship in sync when damage hits a network duplicate. */
  private applyDamageToLocalPlayerIfTarget(data: {
    targetPlayerId: string;
    remainingHealth: number;
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
    if (data.isDestroyed && !localPlayer.ship.exploding) {
      localPlayer.ship.explode();
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
