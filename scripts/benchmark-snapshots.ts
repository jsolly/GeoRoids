import { performance } from 'node:perf_hooks';
import { captureSnapshot, encodeSnapshot, SNAPSHOT_KEYFRAME_INTERVAL, SnapshotDecoder, type SnapshotBaseline } from '../shared/snapshotProtocol';
import { snapshotFixture } from '../tests/unit/network/snapshotFixture';

const iterations = 900;
const worlds = Array.from({ length: iterations }, (_, i) => snapshotFixture(i));
function measure(mode: 'legacy' | 'complete' | 'lean') {
  global.gc?.();
  const initial = process.memoryUsage().heapUsed;
  let peak = initial;
  let bytes = 0;
  let baseline: SnapshotBaseline | undefined;
  const decoder = new SnapshotDecoder();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const world = worlds[i]!;
    if (mode === 'lean') {
      const state = captureSnapshot(world);
      const frame = encodeSnapshot(state, i + 1, i % (SNAPSHOT_KEYFRAME_INTERVAL + 1) ? baseline : undefined);
      const text = JSON.stringify({ type: 'snapshot', data: frame, timestamp: 0 });
      bytes += Buffer.byteLength(text);
      decoder.decode(JSON.parse(text).data);
      baseline = { sequence: i + 1, state };
    } else {
      const { satelliteProjectiles: _shots, collabTags: _tags, ...legacy } = world;
      const text = JSON.stringify({ type: 'gameState', data: mode === 'legacy' ? legacy : world, timestamp: 0 });
      bytes += Buffer.byteLength(text);
      JSON.parse(text);
    }
    if (i % 10 === 0) { peak = Math.max(peak, process.memoryUsage().heapUsed); }
  }
  const ms = performance.now() - start;
  baseline = undefined;
  decoder.reset();
  global.gc?.();
  return { bytes, bytesPerTick: Math.round(bytes / iterations), millisecondsPerTick: +(ms / iterations).toFixed(3), sampledHeapGrowthBytes: peak - initial, retainedHeapBytes: process.memoryUsage().heapUsed - initial };
}
// Warm every code path before measuring; heap samples are not allocation counters.
measure('legacy'); measure('complete'); measure('lean');
const legacy = measure('legacy'); const complete = measure('complete'); const lean = measure('lean');
process.stdout.write(`${JSON.stringify({ fixture: { ships: 10, asteroids: 80, loot: 15, satellites: 6, pickups: 2, activeProjectiles: '0–6', ticks: iterations }, legacy, complete, lean, byteReductionVsLegacyPercent: +((1 - lean.bytes / legacy.bytes) * 100).toFixed(1), byteReductionVsCompletePercent: +((1 - lean.bytes / complete.bytes) * 100).toFixed(1), cpuRatioVsLegacy: +(lean.millisecondsPerTick / legacy.millisecondsPerTick).toFixed(2), gcAvailable: Boolean(global.gc) }, null, 2)}\n`);
