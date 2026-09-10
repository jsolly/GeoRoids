import assert from 'node:assert/strict';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  collectLiveReportMetadata,
  createLiveReport,
  errorRecord,
  validateHealth,
  writeLiveReport,
} from './live-report';
import { networkProfiles } from './network-profiles';
import { Pilot } from './pilot';
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
    network: { type: 'string', default: 'clean' },
  },
});
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
assert(Number.isInteger(pilots) && pilots >= 1 && pilots <= 50, 'pilots must be 1..50');
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 1800, 'seconds must be 1..1800');
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 300, 'warmup must be 0..300');
assert(
  Number.isFinite(admissionMs) && admissionMs >= 1250,
  'admission-ms must be at least 1250 to respect connection admission limits'
);
const url = new URL(
  values.url ?? `ws://127.0.0.1:${process.env['GEOROIDS_TEST_SERVER_PORT'] ?? 3001}/ws`
);
url.searchParams.set('snapshotVersion', '1');
url.searchParams.set('asteroidInteractions', '1');
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
    const client = new Pilot(i, { url, measuring: () => measuring, fail });
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
        if (measuring) {
          client.performanceBudget.observe('stateAgeMs', now - client.lastStateAt, 2000);
        }
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
    assert(client.measuredMotionCommands > 0, 'No measured poses offered');
    assert(client.acknowledgedMotionStates > 0, 'Server did not acknowledge poses');
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
