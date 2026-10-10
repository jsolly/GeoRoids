import { WebSocket } from 'ws';
import { logger } from '../../setup/serverLogger';
import { canCollectEquipment, isEquipmentId } from '../../shared/equipment';
import {
  SNAPSHOT_BACKPRESSURE_BYTES,
  SNAPSHOT_VERSION,
  type SnapshotBaseline,
  SnapshotBroadcastCapture,
  SnapshotEncoder,
} from '../../shared/snapshotProtocol';
import { captureDiagnosticActorState, shouldSampleSnapshot } from '../../shared/stateDiagnostics';
import {
  asteroidReach,
  isWithinWorldInterest,
  nearbyAsteroidRows,
  nearbyWorldRows,
} from '../../shared/world';
import type { AsteroidData, SatellitePickupCollected } from '../../shared-types';
import { isActiveScanner } from '../../src/entities/ship/surveyScan';
import type { CombatBroadcast, GameEngine } from '../core/GameEngine';
import { type OutboundOutcome, serverPerformanceMetrics } from '../performanceMetrics';
import { SERVER_RELEASE_ID } from '../release';

interface SnapshotFlight {
  sequence: number;
  bytes: number;
  submittedAt: number;
  kind: 'ordinary' | 'recovery';
}

interface SnapshotSubmission extends SnapshotFlight {
  generation: number;
  applied: boolean;
}

interface SnapshotRecipient {
  baseline?: SnapshotBaseline;
  sequence: number;
  pending?: SnapshotSubmission;
  needsKeyframe: boolean;
  generation: number;
  appliedSequence: number;
  flights: SnapshotFlight[];
  outstandingBytes: number;
  resyncRequested: boolean;
  recoverySequence?: number;
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

type OutboundClass = 'snapshot' | 'event' | 'control';
type OutboundSendResult = 'sent' | 'skipped-pressure' | 'closed-pressure' | 'not-open';
const OUTBOUND_FRAME_HEADER_RESERVE_BYTES = 10;
// Eight snapshots pipeline a 30 Hz stream through ordinary round-trip latency.
// Applied acknowledgments bound bytes already accepted by TCP, which are absent
// from ws.bufferedAmount. At 125,000 bytes/s, 64 KiB drains in about 524 ms.
const SNAPSHOT_APPLIED_WINDOW_BYTES = 64 * 1024;
const SNAPSHOT_APPLIED_WINDOW_FRAMES = 8;
const SNAPSHOT_APPLIED_OFFER_MAX_AGE_MS = 750;
const SNAPSHOT_APPLIED_TIMEOUT_MS = 6000;
const SNAPSHOT_LARGE_APPLIED_TIMEOUT_MS = 10_000;

function outboundClass(message: unknown): OutboundClass {
  switch (messageType(message)) {
    case 'snapshot':
    case 'asteroidCreateBatch':
      return 'snapshot';
    case 'error':
    case 'joined':
    case 'pong':
    case 'sessionExpired':
      return 'control';
    default:
      return 'event';
  }
}

function bufferedBytes(ws: WebSocket): number {
  return Number.isFinite(ws.bufferedAmount) ? Math.max(0, ws.bufferedAmount) : 0;
}

function recordOutbound(
  kind: OutboundClass,
  outcome: OutboundOutcome,
  payloadBytes = 0,
  queuedBytes = 0
): void {
  if (!serverPerformanceMetrics.enabled) {
    return;
  }
  serverPerformanceMetrics.recordOutbound({
    kind,
    outcome,
    payloadBytes,
    bufferedBytes: queuedBytes,
  });
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

    // Periodic game state broadcast (30 FPS)
    this.broadcastInterval = setInterval(() => {
      if (this.gameEngine.getPlayerCount() > 0) {
        this.broadcastGameState();
      }
    }, 1000 / 30); // 30 FPS (33.33ms)
  }

  public stopPeriodicBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  public broadcastGameState(excludeId?: string): void {
    if (!serverPerformanceMetrics.enabled) {
      this.broadcastGameStateInternal(excludeId);
      return;
    }
    const startedAt = globalThis.performance.now();
    try {
      this.broadcastGameStateInternal(excludeId);
    } finally {
      serverPerformanceMetrics.recordBroadcast(globalThis.performance.now() - startedAt);
    }
  }

  private broadcastGameStateInternal(excludeId?: string): void {
    for (const id of this.gameEngine.drainDepartedPlayers()) {
      this.broadcastPlayerLeft(id);
    }
    this.flushSatellitePickupCollections();
    for (const delivery of this.gameEngine.drainFurnaceDeliveries()) {
      for (const reward of delivery.rewards) {
        this.broadcastScoreUpdate(reward.playerId, reward.score);
      }
      this.broadcastAsteroidDestruction(delivery.asteroidId, { consumedBy: 'furnace' });
      this.broadcastToAll({ type: 'furnaceDelivery', data: delivery, timestamp: Date.now() });
    }
    for (const data of this.gameEngine.drainShotSounds()) {
      this.broadcastToAll({ type: 'playerShotFired', data, timestamp: Date.now() }, data.ownerId);
    }
    for (const data of this.gameEngine.drainTapEjections()) {
      this.broadcastToAll({ type: 'tapEjected', data, timestamp: Date.now() });
    }
    for (const data of this.gameEngine.drainLootCollections()) {
      const message = { type: 'lootCollected', data, timestamp: Date.now() };
      if (isEquipmentId(data.kind)) {
        // Equipment drops are private to each eligible ship; do not reveal them to others.
        const ws = this.gameEngine.getPlayer(data.collectorId)?.ws;
        if (ws) {
          this.sendToWebSocket(ws, message);
        }
      } else {
        this.broadcastToAll(message);
      }
    }
    let gameState: ReturnType<GameEngine['getSnapshotState']> | undefined;
    let capture: SnapshotBroadcastCapture | undefined;
    // Snapshot rows are the engine's live rows, so the engine's frame index covers them.
    const asteroidIndex = this.gameEngine.getAsteroidSpatialIndex();
    const timestamp = Date.now();

    for (const blast of this.gameEngine.drainLootBlasts()) {
      this.broadcastLootExploded(blast);
    }
    const players = this.gameEngine.getAllPlayers();
    let playerProjectiles: ReturnType<GameEngine['getPlayerProjectiles']> | undefined;
    for (const player of players) {
      const ws = player.ws;
      if (!ws || (excludeId && player.id === excludeId)) {
        continue;
      }
      const recipient = this.snapshotRecipients.get(ws);
      if (!recipient) {
        logger.warn('Closing gameplay socket without a negotiated snapshot recipient', {
          playerId: player.id,
        });
        this.closeSocketForRecovery(ws, 1002, 'Snapshot negotiation required');
        continue;
      }
      if (ws.readyState !== WebSocket.OPEN) {
        recipient.needsKeyframe = true;
        continue;
      }
      if (!this.canOfferSnapshot(ws, recipient)) {
        continue;
      }
      try {
        // Prepare common rows only once, after a recipient can accept this broadcast.
        capture ??= new SnapshotBroadcastCapture();
        gameState ??= this.gameEngine.getSnapshotState();
        playerProjectiles ??= this.gameEngine.getPlayerProjectiles();
        const scanning = isActiveScanner(player);
        const reach = asteroidReach(scanning);
        const asteroids = nearbyAsteroidRows(
          asteroidIndex.query({
            minX: player.position.x - reach,
            minY: player.position.y - reach,
            maxX: player.position.x + reach,
            maxY: player.position.y + reach,
          }),
          player.position,
          scanning
        );
        const canonical = new SnapshotEncoder(
          {
            ...gameState,
            entities: gameState.entities.map((entity) =>
              entity.id === player.id ||
              !entity.utilityFlight ||
              isWithinWorldInterest(entity.utilityFlight.position, player.position)
                ? entity
                : { ...entity, utilityFlight: null }
            ),
            asteroids,
            loot: this.gameEngine
              .getNearbyLoot(player.position)
              .filter(
                (drop) => !isEquipmentId(drop.kind) || canCollectEquipment(player, drop.kind)
              ),
            satellitePickups: [
              ...gameState.satellitePickups.filter((pickup) => pickup.ownerId === player.id),
              ...nearbyWorldRows(
                gameState.satellitePickups.filter(
                  (pickup) => pickup.ownerId !== player.id && pickup.state !== 'stored'
                ),
                player.position
              ),
            ],
            playerProjectiles: nearbyWorldRows(playerProjectiles, player.position),
          },
          capture
        );
        const sequence = recipient.sequence + 1;
        // Ordered delivery retains the successful baseline indefinitely. Joins
        // and explicit recovery require full worlds; the encoder also chooses
        // full when its actual envelope is no larger than the delta.
        const encoded = canonical.encodeSerialized(
          sequence,
          recipient.needsKeyframe ? undefined : recipient.baseline,
          timestamp
        );
        const { frame } = encoded;
        const bytes = Buffer.byteLength(encoded.text, 'utf8') + OUTBOUND_FRAME_HEADER_RESERVE_BYTES;
        const recovery = recipient.resyncRequested;
        if (!this.canAdmitSnapshot(recipient, bytes, recovery)) {
          recordOutbound('snapshot', 'pressure-skipped', 0, bufferedBytes(ws));
          continue;
        }
        const submission: SnapshotSubmission = {
          sequence,
          bytes,
          submittedAt: globalThis.performance.now(),
          kind: recovery ? 'recovery' : 'ordinary',
          generation: recipient.generation,
          applied: false,
        };
        const requiredKeyframe = recipient.needsKeyframe;
        recipient.pending = submission;
        recipient.outstandingBytes += bytes;
        if (recovery) {
          recipient.recoverySequence = sequence;
        }
        recipient.needsKeyframe = false;
        const deliveredState = canonical.state;
        const recipientPlayerId = player.id;
        const result = this.sendSerialized(ws, encoded.text, 'snapshot', (error) => {
          // One physical socket owns its sequence frontier even across rejoin.
          if (this.snapshotRecipients.get(ws) !== recipient || recipient.pending !== submission) {
            return;
          }
          delete recipient.pending;
          if (error) {
            recipient.outstandingBytes -= bytes;
            if (recipient.recoverySequence === sequence) {
              delete recipient.recoverySequence;
            }
            recipient.needsKeyframe = true;
            logger.error('Snapshot transport failed; reconnect for state recovery', error);
            this.closeSocketForRecovery(
              ws,
              1011,
              'Snapshot transport failed; reconnect for state recovery'
            );
            return;
          }
          recipient.sequence = sequence;
          recipient.flights.push({
            sequence,
            bytes,
            submittedAt: submission.submittedAt,
            kind: submission.kind,
          });
          // An old accepted frame still consumes sequence/credit, but its
          // baseline cannot cross the new joined acknowledgment.
          if (submission.generation === recipient.generation) {
            recipient.baseline = { sequence, state: deliveredState };
          } else {
            recipient.needsKeyframe = true;
          }
          if (submission.applied) {
            this.applySnapshotCredit(recipient, sequence);
          }
          if (shouldSampleSnapshot(sequence)) {
            const authoritative = deliveredState.entities.find(
              (entity) => entity.id === recipientPlayerId
            );
            logger.info('STATE', 'snapshot_sent_to_transport', {
              releaseId: SERVER_RELEASE_ID,
              playerId: recipientPlayerId,
              sentAt: timestamp,
              gameTime: deliveredState.gameTime,
              snapshotSequence: sequence,
              snapshotKind: frame.kind,
              ...(frame.kind === 'delta' ? { snapshotBaseline: frame.baseline } : {}),
              ...(authoritative?.playerMotion
                ? {
                    motionEpoch: authoritative.playerMotion.epoch,
                    motionAck: authoritative.playerMotion.ack,
                    motionMode: authoritative.playerMotion.mode,
                  }
                : {}),
              ...(authoritative
                ? { authoritativeRow: captureDiagnosticActorState(authoritative) }
                : {}),
            });
          }
        });
        if (result !== 'sent') {
          if (recipient.pending === submission) {
            delete recipient.pending;
            recipient.outstandingBytes -= bytes;
            if (recipient.recoverySequence === sequence) {
              delete recipient.recoverySequence;
            }
            recipient.needsKeyframe ||= requiredKeyframe;
          }
        }
      } catch (error) {
        if (recipient.pending) {
          recipient.outstandingBytes -= recipient.pending.bytes;
          if (recipient.recoverySequence === recipient.pending.sequence) {
            delete recipient.recoverySequence;
          }
          delete recipient.pending;
        }
        recipient.needsKeyframe = true;
        logger.error('Failed to encode or send snapshot', error);
        // No partial state or silent format fallback after negotiation.
        this.closeFailedSnapshotSocket(ws);
      }
    }
  }

  private canOfferSnapshot(ws: WebSocket, recipient: SnapshotRecipient): boolean {
    const oldest = recipient.flights[0] ?? recipient.pending;
    const now = globalThis.performance.now();
    const large = recipient.outstandingBytes > SNAPSHOT_APPLIED_WINDOW_BYTES;
    if (
      oldest &&
      now - oldest.submittedAt >=
        (large ? SNAPSHOT_LARGE_APPLIED_TIMEOUT_MS : SNAPSHOT_APPLIED_TIMEOUT_MS)
    ) {
      recordOutbound('snapshot', 'pressure-closed', 0, bufferedBytes(ws));
      this.closeSocketForRecovery(ws, 1013, 'Applied snapshot acknowledgments timed out');
      return false;
    }
    if (recipient.pending) {
      recordOutbound('snapshot', 'pressure-skipped', 0, bufferedBytes(ws));
      return false;
    }
    if (
      ws.bufferedAmount > SNAPSHOT_BACKPRESSURE_BYTES ||
      recipient.recoverySequence !== undefined ||
      large ||
      (!recipient.resyncRequested &&
        (recipient.flights.length >= SNAPSHOT_APPLIED_WINDOW_FRAMES ||
          recipient.outstandingBytes >= SNAPSHOT_APPLIED_WINDOW_BYTES ||
          (oldest && now - oldest.submittedAt >= SNAPSHOT_APPLIED_OFFER_MAX_AGE_MS)))
    ) {
      recordOutbound('snapshot', 'pressure-skipped', 0, bufferedBytes(ws));
      return false;
    }
    return true;
  }

  private canAdmitSnapshot(
    recipient: SnapshotRecipient,
    bytes: number,
    recovery: boolean
  ): boolean {
    if (recovery) {
      // One reserved keyframe breaks the no-ACK/rejected-delta deadlock. Older
      // debt stays charged until this complete replacement is actually applied.
      return recipient.recoverySequence === undefined;
    }
    if (bytes > SNAPSHOT_APPLIED_WINDOW_BYTES) {
      // Initial, recovery or interest-changing frames can exceed the window.
      // One indivisible large frame may travel alone, never as a growing queue.
      return recipient.flights.length === 0;
    }
    return (
      recipient.flights.length < SNAPSHOT_APPLIED_WINDOW_FRAMES &&
      recipient.outstandingBytes + bytes <= SNAPSHOT_APPLIED_WINDOW_BYTES
    );
  }

  /** Cumulative application credit belongs to the currently owning socket. */
  public acknowledgeSnapshot(ws: WebSocket, sequence: number): boolean {
    const recipient = this.snapshotRecipients.get(ws);
    const owner = this.gameEngine.getPlayerBySocket(ws);
    if (
      !recipient ||
      !owner ||
      owner.ws !== ws ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0
    ) {
      return false;
    }
    if (sequence < recipient.appliedSequence) {
      return false;
    }
    if (sequence === recipient.appliedSequence) {
      return true;
    }
    if (sequence > recipient.sequence) {
      // A peer can finish applying before Node runs its write callback. Retain
      // that receipt but release no credit or baseline until transport succeeds.
      if (sequence === recipient.pending?.sequence) {
        recipient.pending.applied = true;
        return true;
      }
      return false;
    }
    this.applySnapshotCredit(recipient, sequence);
    return true;
  }

  private applySnapshotCredit(recipient: SnapshotRecipient, sequence: number): void {
    recipient.appliedSequence = sequence;
    let retired = 0;
    for (const flight of recipient.flights) {
      if (flight.sequence > sequence) {
        break;
      }
      recipient.outstandingBytes -= flight.bytes;
      if (flight.kind === 'recovery') {
        delete recipient.recoverySequence;
        recipient.resyncRequested = false;
      }
      retired++;
    }
    recipient.flights.splice(0, retired);
  }

  private closeFailedSnapshotSocket(ws: WebSocket): void {
    try {
      ws.close(1011, 'Snapshot encoding failed');
    } catch (error) {
      logger.error('Failed to close snapshot socket', error);
    }
  }

  /** Register the current snapshot-v3 recipient before the join acknowledgment. */
  public negotiateSnapshot(ws: WebSocket): typeof SNAPSHOT_VERSION {
    const existing = this.snapshotRecipients.get(ws);
    if (existing) {
      // Same-socket rejoin never reuses a sent sequence or forgets TCP debt.
      existing.generation++;
      delete existing.baseline;
      existing.needsKeyframe = true;
      // A queued decode-recovery request still owns this socket's single
      // reserve. Rejoin must not strand its preserved, unacknowledgeable debt.
      return SNAPSHOT_VERSION;
    }
    this.snapshotRecipients.set(ws, {
      sequence: 0,
      needsKeyframe: true,
      generation: 0,
      appliedSequence: 0,
      flights: [],
      outstandingBytes: 0,
      resyncRequested: false,
    });
    return SNAPSHOT_VERSION;
  }

  /** Request a keyframe and return its earliest possible sequence as a lower bound. */
  public requestSnapshotKeyframe(
    ws: WebSocket,
    options: { recovery?: boolean } = {}
  ): number | undefined {
    const recipient = this.snapshotRecipients.get(ws);
    if (recipient) {
      if (options.recovery && recipient.resyncRequested) {
        return recipient.recoverySequence ?? recipient.sequence + 1;
      }
      if (options.recovery && recipient.outstandingBytes > SNAPSHOT_APPLIED_WINDOW_BYTES) {
        // A rejected sole oversized frame cannot be followed by a second one
        // without violating the hard one-large-frame memory bound.
        this.closeSocketForRecovery(ws, 1013, 'Oversized snapshot recovery requires reconnect');
        return undefined;
      }
      // Coalesce requests; the periodic broadcast supplies the keyframe.
      recipient.needsKeyframe = true;
      recipient.resyncRequested ||= options.recovery === true;
      return recipient.sequence + 1;
    }
    return undefined;
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

  public broadcastCombatResult(result: CombatBroadcast): void {
    this.broadcastPlayerDamaged(
      result.targetId,
      result.attackerId,
      result.damage,
      result.remainingHealth,
      result.isDestroyed
    );

    if (result.destroyedAsteroidId) {
      this.broadcastAsteroidDestruction(
        result.destroyedAsteroidId,
        result.origin !== undefined ? { origin: result.origin } : undefined
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
    isDestroyed: boolean
  ): void {
    const message = {
      type: 'playerDamaged',
      data: {
        targetPlayerId,
        attackerId,
        damage,
        remainingHealth,
        isDestroyed,
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

  public broadcastSatellitePickupCollected(data: SatellitePickupCollected): void {
    this.broadcastToAll({
      type: 'satellitePickupCollected',
      data,
      timestamp: Date.now(),
    });
  }

  private flushSatellitePickupCollections(): void {
    for (const event of this.gameEngine.drainSatellitePickupCollections()) {
      this.broadcastScoreUpdate(
        event.playerId,
        this.gameEngine.getPlayer(event.playerId)?.score ?? 0
      );
      this.broadcastSatellitePickupCollected(event);
    }
  }

  public broadcastAsteroidCreation(asteroids: readonly AsteroidData[]): void {
    for (const player of this.gameEngine.getAllPlayers()) {
      if (!player.ws) {
        continue;
      }
      const nearby = nearbyAsteroidRows(asteroids, player.position, isActiveScanner(player));
      if (nearby.length > 0) {
        this.sendToWebSocket(player.ws, {
          type: 'asteroidCreateBatch',
          data: { asteroids: nearby },
          timestamp: Date.now(),
        });
      }
    }
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
    extras?: { origin?: { x: number; y: number }; consumedBy?: 'furnace' }
  ): void {
    const message = {
      type: 'asteroidDestroy',
      data: {
        asteroidId,
        ...(extras?.origin !== undefined ? { origin: extras.origin } : {}),
        ...(extras?.consumedBy === 'furnace' ? { consumedBy: 'furnace' as const } : {}),
      },
      timestamp: Date.now(),
    };

    this.broadcastToAll(message);
  }

  public broadcastAsteroidUpdate(asteroidId: string, updates: AsteroidUpdateData): void {
    const message = {
      type: 'asteroidUpdate',
      data: { asteroidId, updates },
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

  private closeSocketForRecovery(ws: WebSocket, code: number, reason: string): void {
    const player = this.gameEngine.getPlayerBySocket(ws);
    const resumable = this.gameEngine.transportClosed(ws);
    if (!resumable && player) {
      const removed = this.gameEngine.removePlayer(player.id);
      if (removed) {
        this.broadcastPlayerLeft(player.id);
      }
    }
    try {
      ws.close(code, reason);
    } catch (error) {
      logger.error('Failed to close WebSocket for state recovery', error);
    }
  }

  private sendSerialized(
    ws: WebSocket,
    message: string,
    kind: OutboundClass,
    onComplete?: (error?: Error) => void
  ): OutboundSendResult {
    const queuedBytes = bufferedBytes(ws);
    const payloadBytes = Buffer.byteLength(message, 'utf8');
    if (ws.readyState !== WebSocket.OPEN) {
      recordOutbound(kind, 'not-open', payloadBytes, queuedBytes);
      return 'not-open';
    }
    const projectedBytes = queuedBytes + payloadBytes + OUTBOUND_FRAME_HEADER_RESERVE_BYTES;
    if (projectedBytes > SNAPSHOT_BACKPRESSURE_BYTES) {
      const permanentlyOversized =
        payloadBytes + OUTBOUND_FRAME_HEADER_RESERVE_BYTES > SNAPSHOT_BACKPRESSURE_BYTES;
      const shouldClose = kind !== 'snapshot' || permanentlyOversized;
      const outcome = shouldClose ? 'pressure-closed' : 'pressure-skipped';
      recordOutbound(kind, outcome, payloadBytes, queuedBytes);
      if (shouldClose) {
        this.closeSocketForRecovery(ws, 1013, 'Backpressure; reconnect for state recovery');
        return 'closed-pressure';
      }
      return 'skipped-pressure';
    }

    try {
      if (onComplete) {
        const submittedAt = globalThis.performance.now();
        ws.send(message, (error) => {
          if (!error) {
            serverPerformanceMetrics.recordTransportAcceptance(
              globalThis.performance.now() - submittedAt
            );
          }
          recordOutbound(kind, error ? 'failed' : 'accepted', payloadBytes, bufferedBytes(ws));
          onComplete(error);
        });
      } else {
        ws.send(message);
        recordOutbound(kind, 'accepted', payloadBytes, queuedBytes);
      }
      return 'sent';
    } catch (error) {
      recordOutbound(kind, 'failed', payloadBytes, queuedBytes);
      throw error;
    }
  }

  public sendToWebSocket(ws: WebSocket, message: unknown): void {
    let messageStr: string;
    try {
      messageStr = JSON.stringify(message);
    } catch (error) {
      recordOutbound(outboundClass(message), 'failed');
      logger.error('Failed to serialize direct message', {
        type: messageType(message),
        error:
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : JSON.stringify(error),
      });
      return;
    }
    this.sendSerialized(ws, messageStr, outboundClass(message));
  }

  public sendError(ws: WebSocket, message: string): void {
    this.sendToWebSocket(ws, {
      type: 'error',
      data: message,
      timestamp: Date.now(),
    });
  }

  public broadcastToAll(message: unknown, excludeId?: string): void {
    if (!serverPerformanceMetrics.enabled) {
      this.broadcastToAllInternal(message, excludeId);
      return;
    }
    const startedAt = globalThis.performance.now();
    try {
      this.broadcastToAllInternal(message, excludeId);
    } finally {
      serverPerformanceMetrics.recordBroadcast(globalThis.performance.now() - startedAt);
    }
  }

  private broadcastToAllInternal(message: unknown, excludeId?: string): void {
    let messageStr: string;
    try {
      messageStr = JSON.stringify(message);
    } catch (error) {
      // A circular Timeout on player.ws used to kill the process here and
      // flap every client into the Reconnecting banner (#485 live miss).
      logger.error('Failed to serialize broadcast', {
        type: messageType(message),
        error:
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : JSON.stringify(error),
      });
      return;
    }
    const players = this.gameEngine.getAllPlayers();

    for (const player of players) {
      if (excludeId && player.id === excludeId) {
        continue;
      }

      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        try {
          this.sendSerialized(player.ws, messageStr, outboundClass(message));
        } catch (error) {
          logger.error(
            `Failed to send message to player ${player.id} (readyState: ${player.ws.readyState})`,
            error
          );
          this.closeSocketForRecovery(
            player.ws,
            1011,
            'Transport failure; reconnect for state recovery'
          );
        }
      }
    }
  }
}
