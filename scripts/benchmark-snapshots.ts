import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  SNAPSHOT_KEYFRAME_INTERVAL,
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../shared/snapshotProtocol';
import { snapshotFixture } from '../tests/unit/network/snapshotFixture';

const iterations = 900;
const worlds = Array.from({ length: iterations }, (_, i) => snapshotFixture(i));
const broadcastWorlds = worlds.slice(0, 181);
type BaselinePattern = 'shared' | 'staggered';

function broadcast(
  count: number,
  pattern: BaselinePattern,
  observe?: (text: string, state: SnapshotEncoder['state'], pilot: number) => void
) {
  const recipients: Array<{
    sequence: number;
    sinceKeyframe: number;
    baseline?: SnapshotBaseline;
  }> = Array.from({ length: count }, (_, sequence) => ({ sequence, sinceKeyframe: 0 }));
  let bytes = 0;
  let messages = 0;
  let keyframes = 0;
  for (const [tick, world] of broadcastWorlds.entries()) {
    // One capture per world, shared across recipients as in the broadcaster.
    const encoder = new SnapshotEncoder(world);
    for (const [index, recipient] of recipients.entries()) {
      // Excluded recipients retain their last delivered world. On the next send,
      // their older baseline requires a different patch from the same encoder.
      if (pattern === 'staggered' && (tick + index) % 5 === 0) {
        continue;
      }
      const sequence = recipient.sequence + 1;
      const frame = encoder.encode(
        sequence,
        recipient.sinceKeyframe >= SNAPSHOT_KEYFRAME_INTERVAL ? undefined : recipient.baseline
      );
      const text = JSON.stringify({ type: 'snapshot', data: frame, timestamp: 0 });
      bytes += Buffer.byteLength(text);
      messages++;
      if (frame.kind === 'keyframe') {
        keyframes++;
      }
      observe?.(text, encoder.state, index);
      recipient.sequence = sequence;
      recipient.sinceKeyframe = frame.kind === 'keyframe' ? 0 : recipient.sinceKeyframe + 1;
      recipient.baseline = { sequence, state: encoder.state };
    }
  }
  return { bytes, messages, keyframes };
}

function measureBroadcast(recipients: number, pattern: BaselinePattern) {
  // Exercise and check the same code path outside the timed samples.
  const decoders = Array.from({ length: recipients }, () => new SnapshotDecoder());
  broadcast(recipients, pattern, (text, state, pilot) => {
    const decoder = decoders[pilot];
    assert(decoder, 'Missing benchmark recipient');
    assert.deepEqual(decoder.decode(JSON.parse(text).data), state);
  });
  const totals = broadcast(recipients, pattern);
  const samples = [];
  for (let batch = 0; batch < 7; batch++) {
    const start = performance.now();
    const result = broadcast(recipients, pattern);
    samples.push((performance.now() - start) / broadcastWorlds.length);
    assert.deepEqual(result, totals, 'Benchmark workload changed between samples');
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert(median !== undefined && p95 !== undefined);
  return {
    recipients,
    pattern,
    worldsPerBatch: broadcastWorlds.length,
    batches: samples.length,
    medianMsPerBroadcast: +median.toFixed(4),
    p95BatchMeanMsPerBroadcast: +p95.toFixed(4),
    ...totals,
  };
}

function measure(mode: 'legacy' | 'complete' | 'lean') {
  global.gc?.();
  const initial = process.memoryUsage().heapUsed;
  let peak = initial;
  let bytes = 0;
  let baseline: SnapshotBaseline | undefined;
  const decoder = new SnapshotDecoder();
  const start = performance.now();
  for (const [i, world] of worlds.entries()) {
    if (mode === 'lean') {
      const encoder = new SnapshotEncoder(world);
      const state = encoder.state;
      const frame = encoder.encode(
        i + 1,
        i % (SNAPSHOT_KEYFRAME_INTERVAL + 1) ? baseline : undefined
      );
      const text = JSON.stringify({ type: 'snapshot', data: frame, timestamp: 0 });
      bytes += Buffer.byteLength(text);
      decoder.decode(JSON.parse(text).data);
      baseline = { sequence: i + 1, state };
    } else {
      const { satelliteProjectiles: _shots, collabTags: _tags, ...legacy } = world;
      const text = JSON.stringify({
        type: 'gameState',
        data: mode === 'legacy' ? legacy : world,
        timestamp: 0,
      });
      bytes += Buffer.byteLength(text);
      JSON.parse(text);
    }
    if (i % 10 === 0) {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
  }
  const ms = performance.now() - start;
  baseline = undefined;
  decoder.reset();
  global.gc?.();
  return {
    bytes,
    bytesPerTick: Math.round(bytes / iterations),
    millisecondsPerTick: +(ms / iterations).toFixed(3),
    sampledHeapGrowthBytes: peak - initial,
    retainedHeapBytes: process.memoryUsage().heapUsed - initial,
  };
}
// Warm every code path before measuring; heap samples are not allocation counters.
measure('legacy');
measure('complete');
measure('lean');
const legacy = measure('legacy');
const complete = measure('complete');
const lean = measure('lean');
const broadcasts = (['shared', 'staggered'] as const).flatMap((pattern) =>
  [1, 2, 5, 10, 25].map((recipients) => measureBroadcast(recipients, pattern))
);
process.stdout.write(
  `${JSON.stringify(
    {
      fixture: {
        ships: 10,
        asteroids: 80,
        loot: 15,
        satellites: 6,
        pickups: 2,
        activeProjectiles: '0–6',
        ticks: iterations,
      },
      legacy,
      complete,
      lean,
      broadcasts,
      broadcastScope:
        'Capture, encode, serialize and count bytes; decode verification outside timing. Staggered recipients skip every fifth world. Percentiles describe seven batch means, not individual tick latency.',
      byteReductionVsLegacyPercent: +((1 - lean.bytes / legacy.bytes) * 100).toFixed(1),
      byteReductionVsCompletePercent: +((1 - lean.bytes / complete.bytes) * 100).toFixed(1),
      cpuRatioVsLegacy: +(lean.millisecondsPerTick / legacy.millisecondsPerTick).toFixed(2),
      gcAvailable: Boolean(global.gc),
    },
    null,
    2
  )}\n`
);
