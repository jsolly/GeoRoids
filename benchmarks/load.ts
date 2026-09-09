import assert from 'node:assert/strict';
import { once } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import { validateSnapshotDto } from '../shared/snapshotDto';
import { SnapshotDecoder } from '../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../shared-types';
import {
  collectLiveReportMetadata,
  createLiveReport,
  errorRecord,
  validateHealth,
  writeLiveReport,
} from './live-report';
import type { Measurement } from './results';
import { startTcpProxy } from './tcp-proxy';

const initialMetadata = collectLiveReportMetadata();
const MIN_STATE_HZ = 27;
const MAX_STATE_GAP_MS = 250;

const { values } = parseArgs({
  options: {
    pilots: { type: 'string', default: '5' },
    seconds: { type: 'string', default: '180' },
    warmup: { type: 'string', default: '30' },
    'admission-ms': { type: 'string', default: '1500' },
    url: { type: 'string' },
    output: { type: 'string', default: '.performance/load.json' },
    'allow-remote': { type: 'boolean', default: false },
    legacy: { type: 'string', default: '0' },
    network: { type: 'string', default: 'clean' },
  },
});
const networkProfiles = {
  clean: { latencyMs: 0, jitterMs: 0, downBytesPerSecond: 625000, upBytesPerSecond: 125000 },
  normal: { latencyMs: 40, jitterMs: 20, downBytesPerSecond: 625000, upBytesPerSecond: 125000 },
  degraded: { latencyMs: 90, jitterMs: 60, downBytesPerSecond: 125000, upBytesPerSecond: 32000 },
};
const networkName = values.network ?? 'clean';
assert(
  networkName === 'clean' || networkName === 'normal' || networkName === 'degraded',
  'Unknown network profile'
);
const networkProfile = networkProfiles[networkName];
let proxy: Awaited<ReturnType<typeof startTcpProxy>> | undefined;
const pilots = Number(values.pilots);
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
const admissionMs = Number(values['admission-ms']);
const legacyCount = Number(values.legacy);
assert(Number.isInteger(pilots) && pilots >= 1 && pilots <= 50, 'pilots must be 1..50');
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 1800, 'seconds must be 1..1800');
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 300, 'warmup must be 0..300');
assert(
  Number.isInteger(legacyCount) && legacyCount >= 0 && legacyCount <= pilots,
  'legacy must be 0..pilots'
);
assert(
  Number.isFinite(admissionMs) && admissionMs >= 1250,
  'admission-ms must be at least 1250 to respect connection admission limits'
);
const url = new URL(
  values.url ?? `ws://127.0.0.1:${process.env['GEOROIDS_TEST_SERVER_PORT'] ?? 3001}/ws`
);
assert(['ws:', 'wss:'].includes(url.protocol), 'Expected ws or wss URL');
assert(!url.username && !url.password, 'Credentials must not appear in benchmark URLs');
assert(
  values['allow-remote'] || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Remote load needs explicit --allow-remote'
);
const healthUrl = new URL('/health', url);
healthUrl.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
const failures: string[] = [];
const health: unknown[] = [];
let totalFailures = 0;
let measuring = false;
function fail(error: unknown) {
  totalFailures++;
  if (failures.length < 100) {
    failures.push(String(error));
  }
}

function isMeasuredHealth(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'measured' in value &&
    value.measured === true &&
    'data' in value &&
    value.data !== null &&
    typeof value.data === 'object'
  );
}

class Pilot {
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
    readonly legacy: boolean
  ) {
    this.id = `benchmark-${index}`;
    this.socket = new WebSocket(url, { perMessageDeflate: false });
    this.socket.on('error', fail);
    this.socket.on('open', () => this.joinGame());
    this.socket.on('close', (code) => {
      if (!this.closing) {
        fail(`Pilot ${index} closed unexpectedly (${code})`);
      }
    });
    this.socket.on('pong', () => {
      if (measuring && this.pingMeasured && this.pingStartedAt !== undefined) {
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
            data && typeof data === 'object' && 'id' in data && data.id === this.id,
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
        if ((message.type === 'snapshot' || message.type === 'gameState') && !this.joined) {
          return;
        }
        if (message.type === 'snapshot') {
          assert(this.joined && !legacy, 'Snapshot without negotiated acknowledgment');
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
          }
        } else if (message.type === 'gameState') {
          assert(legacy && data && typeof data === 'object', 'Unexpected legacy state');
          const state = { satelliteProjectiles: [], collabTags: [], ...data };
          validateSnapshotDto(state);
          this.state = state;
        } else {
          return;
        }
        assert(
          this.state.entities.some((entity) => entity.id === this.id),
          'Authoritative state lost pilot'
        );
        const ownState = this.state.entities.find((entity) => entity.id === this.id);
        const motion = ownState?.asteroidMotion;
        if (
          measuring &&
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
        if (measuring && this.measuredServerTick !== undefined) {
          for (const shot of this.state.playerProjectiles ?? []) {
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
        if (measuring) {
          const now = performance.now();
          this.streamStartedAt ||= now;
          if (this.lastMeasuredStateAt) {
            const gap = now - this.lastMeasuredStateAt;
            this.stateIntervalMs.push(gap);
            assert(gap <= MAX_STATE_GAP_MS, `Authoritative delivery gap ${gap.toFixed(1)}ms`);
          }
          this.lastMeasuredStateAt = now;
          this.measuredStates++;
        } else {
          this.warmupStates++;
        }
        if (measuring && this.decodeMs.length < 60000) {
          this.decodeMs.push(performance.now() - started);
        }
      } catch (error) {
        fail(error);
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
    this.sessionStartedAt = performance.now();
    this.gameJoins++;
    this.send({
      type: 'join',
      id: this.id,
      data: {
        name: `測試-${this.index}`,
        position: { x: 100 + this.index * 70, y: 100 },
        kitId: 'dart',
        ...(this.legacy ? {} : { snapshotVersion: 1, asteroidInteractions: 1 }),
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
    const motion = !this.legacy ? entity.asteroidMotion : undefined;
    const alive = !entity.exploding && entity.health > 0;
    if (alive && motion && ['latched', 'released'].includes(motion.mode)) {
      this.send({
        type: 'asteroidInput',
        data: {
          epoch: motion.epoch,
          sequence: this.sequence,
          thrust: true,
          turn: tick % 80 < 40 ? 1 : -1,
          aimAngle: angle,
        },
      });
    } else if (alive) {
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
    if (alive && motion && measuring) {
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
      if (measuring) {
        this.measuredShotsOffered++;
      }
    }
    if (
      (tick % 100 === 0 || (measuring && this.measuredPings === 0)) &&
      this.pingStartedAt === undefined
    ) {
      if (measuring) {
        this.measuredPings++;
      }
      this.pingStartedAt = performance.now();
      this.pingMeasured = measuring;
      this.socket.ping();
    }
    if (tick > 0 && tick % 600 === 0 && !this.legacy) {
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
    assert(
      performance.now() - this.lastStateAt <= MAX_STATE_GAP_MS,
      'Pilot ended without fresh state'
    );
    assert(this.activeMeasuredMs > 0, 'Pilot had no measured authoritative stream');
    assert(this.measuredPings > 0, 'Pilot had no measured RTT probe');
    assert.equal(this.unansweredMeasuredPings, 0, 'Measured RTT probe was unanswered');
    assert.equal(this.rttMs.length, this.measuredPings, 'Measured RTT probes were omitted');
    if (!this.legacy) {
      assert(this.measuredShotsOffered > 0, 'Pilot offered no measured shots');
      assert(
        this.observedServerShots.size > 0,
        'No authoritative projectile born after measured motion acknowledgment'
      );
    }
    assert(
      this.measuredStates >= (this.measuredWallMs * MIN_STATE_HZ) / 1000 - 2,
      `Authoritative delivery below ${MIN_STATE_HZ}Hz: ${this.measuredStates} states in ${this.measuredWallMs.toFixed(0)}ms`
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
      legacy: this.legacy,
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
      observedMeasuredServerProjectiles: this.legacy ? null : this.observedServerShots.size,
      resyncs: this.resyncs,
      decodeMs: this.decodeMs,
      omittedDecodeSamples: this.measuredStates - this.decodeMs.length,
      measuredPings: this.measuredPings,
      unansweredMeasuredPings: this.unansweredMeasuredPings,
      rttMs: this.rttMs,
    };
  }
}
const clients: Pilot[] = [];
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let generatorCpu: NodeJS.CpuUsage | undefined;
let durationMs = 0;
let measuredDurationMs = 0;
let offeredTicks = 0;
let cleanupComplete = true;
let runStarted = 0;
let measuredStartedAt = 0;
try {
  if (networkName !== 'clean') {
    assert(!values.url, 'Network impairment requires the owned local server');
    proxy = await startTcpProxy({ targetPort: Number(url.port), seed: 42, ...networkProfile });
    url.port = String(proxy.port);
  }
  for (let i = 0; i < pilots; i++) {
    if (i) {
      await delay(admissionMs);
    }
    const client = new Pilot(i, i < legacyCount);
    clients.push(client);
    const deadline = performance.now() + 10000;
    while (client.firstStateAt === undefined && performance.now() < deadline && !totalFailures) {
      await delay(25);
    }
    assert(client.firstStateAt !== undefined, `Pilot ${i} failed admission`);
  }
  runStarted = performance.now();
  let nextAt = runStarted;
  let lastHealthAt = 0;
  measuredStartedAt = warmup === 0 ? runStarted : 0;
  if (warmup === 0) {
    generatorCpu = process.cpuUsage();
    loopDelay.reset();
    measuring = true;
    for (const client of clients) {
      client.beginMeasurement(runStarted);
    }
  }
  while (performance.now() - runStarted < (seconds + warmup) * 1000) {
    await delay(Math.max(0, nextAt - performance.now()));
    const now = performance.now();
    if (now - runStarted >= (seconds + warmup) * 1000) {
      break;
    }
    assert(now - nextAt < 1000, 'Load generator fell over one second behind');
    assert(!totalFailures, 'Protocol or socket failures occurred');
    if (!measuring && now - runStarted >= warmup * 1000) {
      measuring = true;
      measuredStartedAt = now;
      generatorCpu = process.cpuUsage();
      loopDelay.reset();
      for (const client of clients) {
        client.beginMeasurement(now);
      }
    }
    for (const client of clients) {
      if (client.joined) {
        assert(now - client.lastStateAt < 2000, 'Authoritative stream stalled');
      }
      client.drive(offeredTicks);
    }
    offeredTicks++;
    nextAt += 50;
    if (now - lastHealthAt >= 1000) {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      assert(response.ok, 'Server health failed');
      const healthSample: unknown = await response.json();
      validateHealth(healthSample);
      health.push({
        elapsedMs: now - runStarted,
        measured: now - runStarted >= warmup * 1000,
        data: healthSample,
      });
      lastHealthAt = now;
    }
  }
  durationMs = performance.now() - runStarted;
  measuredDurationMs = measuredStartedAt > 0 ? performance.now() - measuredStartedAt : 0;
  for (const client of clients) {
    client.stopMeasurement();
  }
  for (const client of clients) {
    client.validateCompletion();
    assert(client.measuredStates > 0, 'Pilot did not receive measured states');
    if (!client.legacy) {
      assert(client.measuredMotionCommands > 0, 'No measured enhanced poses offered');
      assert(client.acknowledgedMotionStates > 0, 'Server did not acknowledge enhanced poses');
    }
    assert.equal(client.measuredStates, client.decodeMs.length, 'Raw decode samples omitted');
    client.completedScenario = true;
  }
} catch (error) {
  fail(error);
} finally {
  measuring = false;
  for (const client of clients) {
    client.stopMeasurement();
  }
  durationMs = runStarted ? performance.now() - runStarted : 0;
  measuredDurationMs = measuredStartedAt ? performance.now() - measuredStartedAt : 0;
  loopDelay.disable();
  if (generatorCpu) {
    generatorCpu = process.cpuUsage(generatorCpu);
  }
  const closeResults = await Promise.allSettled(clients.map((client) => client.close()));
  for (const result of closeResults) {
    if (result.status === 'rejected') {
      cleanupComplete = false;
      fail(result.reason);
    }
  }
  try {
    await proxy?.close();
    if (proxy) {
      assert.equal(proxy.read().failures, 0, 'TCP impairment proxy failed');
      assert.equal(proxy.read().activeSockets, 0, 'TCP impairment proxy leaked sockets');
    }
  } catch (error) {
    cleanupComplete = false;
    fail(error);
  }
  if (!health.some((entry) => isMeasuredHealth(entry))) {
    fail(new Error('Load report has no measured server health sample'));
  }
  const reports = clients.map((client) => client.report());
  const decodeSamples = clients.flatMap((client) => client.decodeMs);
  const rttSamples = clients.flatMap((client) => client.rttMs);
  const stateIntervals = clients.flatMap((client) => client.stateIntervalMs);
  const samples: Record<string, number[]> = {};
  if (decodeSamples.length > 0) {
    samples['decodeMs'] = decodeSamples;
  }
  if (rttSamples.length > 0) {
    samples['rttMs'] = rttSamples;
  }
  if (stateIntervals.length > 0) {
    samples['stateIntervalMs'] = stateIntervals;
  }
  const measurement: Measurement | undefined =
    cleanupComplete && Object.keys(samples).length
      ? {
          primaryMetric: samples['rttMs'] ? 'rttMs' : 'decodeMs',
          samples,
          counts: {
            offeredPilots: pilots,
            joinedPilots: clients.filter((client) => client.joined).length,
            completedPilots: clients.filter((client) => client.completedScenario).length,
            measuredStates: clients.reduce((sum, client) => sum + client.measuredStates, 0),
            measuredHealthSamples: health.filter((entry) => isMeasuredHealth(entry)).length,
            rawSamples: Object.values(samples).reduce((sum, values) => sum + values.length, 0),
            failures: totalFailures,
          },
          parameters: {
            pilots,
            legacyCount,
            warmupSeconds: warmup,
            measuredSeconds: seconds,
            admissionMs,
            inputHz: 20,
            offeredShotsHz: 2,
            compression: false,
            networkProfile: networkName,
            minimumStateHz: MIN_STATE_HZ,
            maximumStateGapMs: MAX_STATE_GAP_MS,
            serverSeed: values.url ? 'unknown remote server seed' : 42,
            timing: 'Native WebSocket scheduling and decoder application',
          },
          witness: {
            participants: reports,
            healthSamples: health.length,
            durationMs,
            measuredDurationMs,
          },
          cleanup: 'complete',
        }
      : undefined;
  const report = createLiveReport({
    kind: 'websocket-load',
    ...(measurement ? { measurement } : {}),
    metadata: initialMetadata,
    failed: totalFailures > 0,
    details: {
      network: {
        profile: networkName,
        settings: networkProfile,
        measurements: proxy?.read() ?? null,
        scope:
          'Per-connection FIFO chunk impairment, not packet loss or calibrated mobile emulation',
      },
      configuration: {
        pilots,
        legacyCount,
        warmup,
        seconds,
        admissionMs,
        inputHz: 20,
        offeredShotsHz: 2,
        compression: false,
        serverSeed: values.url ? 'unknown remote server seed' : 42,
      },
      offeredPilots: pilots,
      joinedPilots: clients.filter((client) => client.joined).length,
      completedPilots: clients.filter((client) => client.completedScenario).length,
      durationMs,
      measuredDurationMs,
      offeredTicks,
      cleanupComplete,
      generator: {
        cpu: generatorCpu,
        eventLoopP99Ms: loopDelay.percentile(99) / 1e6,
        rss: process.memoryUsage().rss,
      },
      scope:
        'Per-pilot counters distinguish join, authoritative state, and measured scenario completion. No production capacity claim.',
      clients: reports,
      health,
      totalFailures,
      failures: failures.map((error) => errorRecord(error)),
    },
  });
  try {
    await writeLiveReport(values.output ?? '.performance/load.json', report);
  } catch (error) {
    fail(error);
  }
}
if (totalFailures) {
  throw new AggregateError(
    failures.map((error) => new Error(String(error))),
    'WebSocket load failed'
  );
}
process.stdout.write(`Saved WebSocket load report to ${values.output}\n`);
