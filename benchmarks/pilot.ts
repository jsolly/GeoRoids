import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SnapshotDecoder } from '../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../shared-types';
import { PerformanceBudget } from './performance-budget';

export class Pilot {
  readonly performanceBudget = new PerformanceBudget();
  readonly id: string;
  readonly socket: WebSocket;
  readonly decoder = new SnapshotDecoder();
  state: ServerGameSnapshot | undefined;
  joined = false;
  releaseId = 'unknown';
  bytes = 0;
  messages = 0;
  states = 0;
  keyframes = 0;
  shots = 0;
  resyncs = 0;
  lastStateAt = 0;
  firstStateAt: number | undefined;
  joinedAt: number | undefined;
  warmupStates = 0;
  measuredStates = 0;
  readonly startedAt = performance.now();
  sessionStartedAt = this.startedAt;
  gameJoins = 0;
  acknowledgedMotionStates = 0;
  measuredMotionCommands = 0;
  measuredShotsOffered = 0;
  private measuredServerTick: number | undefined;
  private readonly observedServerShots = new Set<string>();
  private measuredMotion:
    | { epoch: number; firstSequence: number; acknowledged: number }
    | undefined;
  private snapshotSequence = 0;
  lastKeyframeSequence = 0;
  private streamStartedAt = 0;
  private activeMeasuredMs = 0;
  private measuredStartedAt = 0;
  private measuredWallMs = 0;
  private lastMeasuredStateAt = 0;
  readonly stateIntervalMs: number[] = [];
  readonly decodeMs: number[] = [];
  readonly rttMs: number[] = [];
  private pingStartedAt: number | undefined;
  private pingMeasured = false;
  private unansweredMeasuredPings = 0;
  private sequence = 0;
  private closing = false;

  completedScenario = false;
  private measuredPings = 0;

  constructor(
    private readonly index: number,
    private readonly options: {
      url: URL;
      measuring: () => boolean;
      fail: (error: unknown) => void;
      minimumStateHz?: number;
      maximumStateGapMs?: number;
      repeatMeasuredPings?: boolean;
      deliveryBudget?: () => { minimumStateHz: number; maximumStateGapMs: number };
    }
  ) {
    this.id = `benchmark-${index}`;
    this.socket = new WebSocket(options.url, { perMessageDeflate: false });
    this.socket.on('error', options.fail);
    this.socket.on('open', () => this.joinGame());
    this.socket.on('close', (code) => {
      if (!this.closing) {
        this.options.fail(`Pilot ${index} closed unexpectedly (${code})`);
      }
    });
    this.socket.on('pong', () => {
      if (this.options.measuring() && this.pingMeasured && this.pingStartedAt !== undefined) {
        this.rttMs.push(performance.now() - this.pingStartedAt);
      }
      this.pingStartedAt = undefined;
    });
    this.socket.on('message', (raw) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      this.bytes += bytes.length;
      this.messages++;
      const started = performance.now();
      try {
        const message: unknown = JSON.parse(bytes.toString());
        assert(
          message && typeof message === 'object' && 'type' in message && 'data' in message,
          'Invalid server envelope'
        );
        const data = message.data;
        if (message.type === 'error') {
          throw new Error(`Server rejected pilot command: ${JSON.stringify(data)}`);
        }
        if (message.type === 'joined') {
          assert(
            data &&
              typeof data === 'object' &&
              'id' in data &&
              data.id === this.id &&
              'snapshotVersion' in data &&
              data.snapshotVersion === 1 &&
              'asteroidInteractions' in data &&
              data.asteroidInteractions === 1 &&
              'resumeToken' in data &&
              typeof data.resumeToken === 'string' &&
              data.resumeToken.length > 0,
            'Invalid joined acknowledgment'
          );
          this.joined = true;
          this.joinedAt ??= performance.now();
          this.decoder.reset();
          this.snapshotSequence = 0;
          if ('serverReleaseId' in data && typeof data.serverReleaseId === 'string') {
            this.releaseId = data.serverReleaseId;
          }
        }
        if (message.type === 'snapshot' && !this.joined) {
          return;
        }
        if (message.type === 'snapshot') {
          assert(this.joined, 'Snapshot without join acknowledgment');
          this.state = this.decoder.decode(data);
          assert(
            data && typeof data === 'object' && 'sequence' in data,
            'Missing snapshot sequence'
          );
          assert.equal(
            data.sequence,
            this.snapshotSequence + 1,
            'Snapshot delivery skipped a sequence'
          );
          this.snapshotSequence++;
          if (data && typeof data === 'object' && 'kind' in data && data.kind === 'keyframe') {
            this.keyframes++;
            this.lastKeyframeSequence = this.snapshotSequence;
          }
        } else {
          return;
        }
        assert(
          this.state.entities.some((entity) => entity.id === this.id),
          'Authoritative state lost pilot'
        );
        const ownState = this.state.entities.find((entity) => entity.id === this.id);
        const motion = ownState?.playerMotion;
        if (
          this.options.measuring() &&
          this.measuredMotion &&
          motion &&
          motion.epoch === this.measuredMotion.epoch &&
          motion.ack >= this.measuredMotion.firstSequence &&
          motion.ack > this.measuredMotion.acknowledged
        ) {
          this.acknowledgedMotionStates++;
          this.measuredMotion.acknowledged = motion.ack;
          this.measuredServerTick ??= this.state.gameTime;
        }
        if (this.options.measuring() && this.measuredServerTick !== undefined) {
          for (const shot of this.state.playerProjectiles) {
            if (
              shot.ownerId === this.id &&
              this.state.gameTime - shot.age > this.measuredServerTick
            ) {
              assert(
                this.observedServerShots.size < 5000,
                'Server projectile witness limit exceeded'
              );
              this.observedServerShots.add(shot.id);
            }
          }
        }
        this.firstStateAt ??= performance.now();
        this.lastStateAt = performance.now();
        this.states++;
        if (this.options.measuring()) {
          const now = performance.now();
          this.streamStartedAt ||= now;
          if (this.lastMeasuredStateAt) {
            const gap = now - this.lastMeasuredStateAt;
            this.stateIntervalMs.push(gap);
            this.performanceBudget.observe(
              'stateGapMs',
              gap,
              this.options.deliveryBudget?.().maximumStateGapMs ??
                this.options.maximumStateGapMs ??
                250
            );
          }
          this.lastMeasuredStateAt = now;
          this.measuredStates++;
        } else {
          this.warmupStates++;
        }
        if (this.options.measuring() && this.decodeMs.length < 60000) {
          this.decodeMs.push(performance.now() - started);
        }
      } catch (error) {
        this.options.fail(error);
      }
    });
  }

  private joinGame() {
    this.finishStream();
    this.measuredMotion = undefined;
    this.measuredServerTick = undefined;
    this.joined = false;
    this.state = undefined;
    this.decoder.reset();
    this.lastKeyframeSequence = 0;
    this.sessionStartedAt = performance.now();
    this.gameJoins++;
    this.send({
      type: 'join',
      id: this.id,
      data: {
        name: `測試-${this.index}`,
        position: { x: 100 + this.index * 70, y: 100 },
        kitId: 'dart',
        snapshotVersion: 1,
        asteroidInteractions: 1,
      },
    });
  }

  send(message: unknown) {
    assert(this.socket.readyState === WebSocket.OPEN, 'Pilot socket unavailable');
    assert(this.socket.bufferedAmount < 256 * 1024, 'Load generator send queue overloaded');
    this.socket.send(JSON.stringify(message));
  }

  drive(tick: number) {
    const entity = this.state?.entities.find((row) => row.id === this.id);
    if (!this.joined) {
      assert(performance.now() - this.sessionStartedAt < 10000, 'Game rejoin timed out');
      return;
    }
    assert(entity, 'Pilot has no authoritative entity');
    if (entity.lives <= 0) {
      this.send({ type: 'leave', data: {} });
      this.joinGame();
      return;
    }
    this.sequence++;
    const angle = Math.atan2(Math.sin(tick * 0.04), Math.cos(tick * 0.04));
    const motion = entity.playerMotion;
    const alive = !entity.exploding && entity.health > 0;
    if (alive) {
      this.send({
        type: 'update',
        id: this.id,
        data: {
          position: {
            x: entity.position.x + Math.cos(angle),
            y: entity.position.y + Math.sin(angle),
          },
          velocity: { x: Math.cos(angle) / 3, y: Math.sin(angle) / 3 },
          angle,
          thrusting: true,
          ...(motion ? { motionEpoch: motion.epoch, motionSequence: this.sequence } : {}),
        },
      });
    }
    if (alive && motion && this.options.measuring()) {
      this.measuredMotionCommands++;
      if (this.measuredMotion?.epoch !== motion.epoch) {
        this.measuredMotion = {
          epoch: motion.epoch,
          firstSequence: this.sequence,
          acknowledged: 0,
        };
      }
    }
    if (tick % 10 === 0 && !entity.exploding) {
      this.send({
        type: 'shoot',
        id: this.id,
        data: {
          laserStart: entity.position,
          laserDirection: { x: Math.cos(entity.angle) * 10, y: Math.sin(entity.angle) * 10 },
        },
      });
      this.shots++;
      if (this.options.measuring()) {
        this.measuredShotsOffered++;
      }
    }
    if (
      ((tick % 100 === 0 &&
        (!this.options.measuring() || this.options.repeatMeasuredPings !== false)) ||
        (this.options.measuring() && this.measuredPings === 0)) &&
      this.pingStartedAt === undefined
    ) {
      if (this.options.measuring()) {
        this.measuredPings++;
      }
      this.pingStartedAt = performance.now();
      this.pingMeasured = this.options.measuring();
      this.socket.ping();
    }
    if (tick > 0 && tick % 600 === 0) {
      this.send({ type: 'snapshotResync', data: {} });
      this.resyncs++;
    }
  }

  beginMeasurement(now: number): void {
    this.measuredMotion = undefined;
    this.measuredServerTick = undefined;
    this.measuredStartedAt = now;
    this.streamStartedAt = this.joined && this.state ? now : 0;
    this.lastMeasuredStateAt = this.streamStartedAt;
  }

  private finishStream(): void {
    if (this.streamStartedAt) {
      this.activeMeasuredMs += performance.now() - this.streamStartedAt;
      this.streamStartedAt = 0;
    }
  }

  stopMeasurement(): void {
    this.finishStream();
    if (this.measuredStartedAt) {
      this.measuredWallMs = performance.now() - this.measuredStartedAt;
      this.measuredStartedAt = 0;
    }
    if (this.pingMeasured && this.pingStartedAt !== undefined) {
      this.unansweredMeasuredPings++;
    }
    this.pingMeasured = false;
  }

  validateCompletion(): void {
    assert(this.joined && this.state, 'Pilot ended with an unfinished game join');
    this.performanceBudget.observe(
      'finalStateAgeMs',
      performance.now() - this.lastStateAt,
      this.options.deliveryBudget?.().maximumStateGapMs ?? this.options.maximumStateGapMs ?? 250
    );
    assert(this.activeMeasuredMs > 0, 'Pilot had no measured authoritative stream');
    assert(this.measuredPings > 0, 'Pilot had no measured RTT probe');
    assert.equal(this.unansweredMeasuredPings, 0, 'Measured RTT probe was unanswered');
    assert.equal(this.rttMs.length, this.measuredPings, 'Measured RTT probes were omitted');
    assert(this.measuredShotsOffered > 0, 'Pilot offered no measured shots');
    assert(
      this.observedServerShots.size > 0,
      'No authoritative projectile born after measured motion acknowledgment'
    );
    assert(this.measuredWallMs > 0 && this.measuredStates > 0, 'Missing measured state delivery');
    this.performanceBudget.observe(
      'stateRateHz',
      (this.measuredStates * 1000) / this.measuredWallMs,
      Math.max(
        0,
        (this.options.deliveryBudget?.().minimumStateHz ?? this.options.minimumStateHz ?? 27) -
          2000 / this.measuredWallMs
      ),
      'minimum'
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = once(this.socket, 'close', { signal: AbortSignal.timeout(5_000) });
    let leaveError: unknown;
    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.send({ type: 'leave', data: {} });
      }
    } catch (error) {
      leaveError = error;
    } finally {
      this.socket.close(1000, 'Benchmark complete');
    }
    try {
      await closed;
    } catch (error) {
      this.socket.terminate();
      await once(this.socket, 'close', { signal: AbortSignal.timeout(5_000) }).catch(
        () => undefined
      );
      throw error;
    }
    if (leaveError) {
      throw leaveError;
    }
  }
  report() {
    return {
      performanceBudget: this.performanceBudget.report(),
      releaseId: this.releaseId,
      joined: this.joined,
      gameJoins: this.gameJoins,
      acknowledgedMotionStates: this.acknowledgedMotionStates,
      measuredMotionCommands: this.measuredMotionCommands,
      activeMeasuredMs: this.activeMeasuredMs,
      measuredWallMs: this.measuredWallMs,
      stateIntervalMs: this.stateIntervalMs,
      states: this.states,
      warmupStates: this.warmupStates,
      measuredStates: this.measuredStates,
      joinMs: this.joinedAt === undefined ? null : this.joinedAt - this.startedAt,
      firstStateMs: this.firstStateAt === undefined ? null : this.firstStateAt - this.startedAt,
      completedScenario: this.completedScenario,
      bytes: this.bytes,
      messages: this.messages,
      keyframes: this.keyframes,
      shotsOffered: this.shots,
      measuredShotsOffered: this.measuredShotsOffered,
      observedMeasuredServerProjectiles: this.observedServerShots.size,
      resyncs: this.resyncs,
      decodeMs: this.decodeMs,
      omittedDecodeSamples: this.measuredStates - this.decodeMs.length,
      measuredPings: this.measuredPings,
      unansweredMeasuredPings: this.unansweredMeasuredPings,
      rttMs: this.rttMs,
    };
  }
}
