import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import { validateSnapshotDto } from '../shared/snapshotDto';
import { SnapshotDecoder, SnapshotEncoder, type SnapshotFrame } from '../shared/snapshotProtocol';
import type { PlayerProjectileState, ServerGameSnapshot } from '../shared-types';
import { snapshotFixture } from '../tests/unit/network/snapshotFixture';
import { type Measurement, validateMeasurement } from './results';

type Variant = 'legacy' | 'keyframe' | 'delta';
type Payloads = Record<Variant, string>;
export interface ProtocolExperimentOptions {
  readonly seed: number;
  readonly warmupTicks: number;
  readonly measuredTicks: number;
}

const DEFAULTS: ProtocolExperimentOptions = { seed: 42, warmupTicks: 30, measuredTicks: 120 };
const variants: readonly Variant[] = ['legacy', 'keyframe', 'delta'];

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

function options(): ProtocolExperimentOptions {
  const result = {
    seed: argument('seed', DEFAULTS.seed),
    warmupTicks: argument('warmup', DEFAULTS.warmupTicks),
    measuredTicks: argument('ticks', DEFAULTS.measuredTicks),
  };
  assert(Number.isSafeInteger(result.seed), 'seed must be a safe integer');
  assert(
    Number.isSafeInteger(result.warmupTicks) && result.warmupTicks > 0,
    'warmup must be positive'
  );
  assert(
    Number.isSafeInteger(result.measuredTicks) && result.measuredTicks > 0,
    'ticks must be positive'
  );
  return result;
}

function envelope(type: string, data: ServerGameSnapshot | SnapshotFrame): string {
  return JSON.stringify({ type, data, timestamp: 0 });
}

function payloads(
  world: ServerGameSnapshot,
  sequence: number,
  previous?: SnapshotEncoder
): Payloads & { encoder: SnapshotEncoder } {
  const encoder = new SnapshotEncoder(world);
  const keyframe = encoder.encode(sequence);
  const delta = previous
    ? encoder.encode(sequence, { sequence: sequence - 1, state: previous.state })
    : keyframe;
  return {
    encoder,
    legacy: envelope('gameState', world),
    keyframe: envelope('snapshot', keyframe),
    delta: envelope('snapshot', delta),
  };
}

function timed<T>(operation: () => T): number {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

function parsedData(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  assert(parsed && typeof parsed === 'object' && 'data' in parsed);
  return parsed.data;
}

function decodeLegacy(text: string): ServerGameSnapshot {
  const state = parsedData(text);
  validateSnapshotDto(state);
  return state;
}

function decodeSnapshot(text: string, decoder: SnapshotDecoder): ServerGameSnapshot {
  return decoder.decode(parsedData(text));
}

/** A small active laser set matching the fields emitted by GameEngine.getPlayerProjectiles(). */
function playerProjectileFixture(tick: number): PlayerProjectileState[] {
  return Array.from({ length: 4 }, (_, index) => {
    const velocity = { x: 4 + index, y: (index - 1) * 0.5 };
    const position = {
      x: 500 + index * 35 + tick * velocity.x,
      y: 120 + index * 18 + tick * velocity.y,
    };
    return {
      id: `server-laser-${index}`,
      ownerId: `pilot-${index % 5}`,
      position,
      prevPosition: {
        x: position.x - velocity.x,
        y: position.y - velocity.y,
      },
      velocity,
      energy: index === 3 ? 2 : 1,
      bounces: (tick + index) % 3,
      age: tick + index,
    };
  });
}

export function runProtocolExperiment(input: ProtocolExperimentOptions = DEFAULTS): Measurement {
  const totalTicks = input.warmupTicks + input.measuredTicks;
  const worlds = Array.from({ length: totalTicks }, (_, tick) => {
    const world = snapshotFixture(input.seed + tick);
    return {
      ...world,
      playerProjectiles: playerProjectileFixture(tick),
      entities: world.entities.map((entity, i) => ({
        ...entity,
        name: i % 2 ? `Pilote Δ ${i}` : `飛行士 🛰️ ${i}`,
      })),
    };
  });
  const history: Array<Payloads & { encoder: SnapshotEncoder }> = [];
  let previous: SnapshotEncoder | undefined;
  for (const [tick, world] of worlds.entries()) {
    const current = payloads(world, tick + 1, previous);
    if (tick > 0) {
      const frame = parsedData(current.delta) as SnapshotFrame;
      assert.equal(frame.kind, 'delta');
    }
    history.push(current);
    previous = current.encoder;
  }

  const samples: Record<string, number[]> = {};
  function samplesFor(name: string): number[] {
    const values = samples[name] ?? [];
    samples[name] = values;
    return values;
  }
  const counts: Record<string, number> = {
    warmupTicks: input.warmupTicks,
    measuredTicks: input.measuredTicks,
  };
  const decoders = { keyframe: new SnapshotDecoder(), delta: new SnapshotDecoder() };
  const timedDecoders = { keyframe: new SnapshotDecoder(), delta: new SnapshotDecoder() };
  for (const [tick, current] of history.entries()) {
    const measured = tick >= input.warmupTicks;
    const world = worlds[tick];
    assert(world);
    const previousState = history[tick - 1]?.encoder.state;
    if (tick > 0) {
      assert(previousState);
    }
    assert.deepEqual(decodeLegacy(current.legacy), world);
    assert.deepEqual(decodeSnapshot(current.keyframe, decoders.keyframe), world);
    assert.deepEqual(decodeSnapshot(current.delta, decoders.delta), world);
    for (const variant of variants) {
      const text = current[variant];
      const encodeSerializeSamples = samplesFor(`${variant}-encode-serialize-ms`);
      const decodeSamples = samplesFor(`${variant}-decode-ms`);
      const gzipSamples = samplesFor(`${variant}-gzip-ms`);
      const deflateSamples = samplesFor(`${variant}-deflate-ms`);
      encodeSerializeSamples.push(
        timed(() => {
          if (variant === 'legacy') {
            envelope('gameState', world);
          } else {
            const encoder = new SnapshotEncoder(world);
            const frame = encoder.encode(
              tick + 1,
              variant === 'delta' && previousState
                ? { sequence: tick, state: previousState }
                : undefined
            );
            envelope('snapshot', frame);
          }
        })
      );
      decodeSamples.push(
        timed(() => {
          if (variant === 'legacy') {
            decodeLegacy(text);
          } else {
            decodeSnapshot(text, timedDecoders[variant]);
          }
        })
      );
      gzipSamples.push(timed(() => gzipSync(Buffer.from(text, 'utf8'))));
      deflateSamples.push(timed(() => deflateSync(Buffer.from(text, 'utf8'))));
      if (!measured) {
        for (const key of Object.keys(samples)) {
          samples[key] = [];
        }
        continue;
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      const gzip = gzipSync(Buffer.from(text, 'utf8'));
      const deflate = deflateSync(Buffer.from(text, 'utf8'));
      assert.equal(gunzipSync(gzip).toString('utf8'), text);
      assert.equal(inflateSync(deflate).toString('utf8'), text);
      const gzipBytes = gzip.byteLength;
      const deflateBytes = deflate.byteLength;
      counts[`${variant}-utf8-bytes-total`] = (counts[`${variant}-utf8-bytes-total`] ?? 0) + bytes;
      counts[`${variant}-gzip-bytes-total`] =
        (counts[`${variant}-gzip-bytes-total`] ?? 0) + gzipBytes;
      counts[`${variant}-deflate-bytes-total`] =
        (counts[`${variant}-deflate-bytes-total`] ?? 0) + deflateBytes;
    }
  }
  for (const variant of variants) {
    counts[`${variant}-messages`] = input.measuredTicks;
    counts[`${variant}-utf8-bytes-mean`] =
      (counts[`${variant}-utf8-bytes-total`] ?? 0) / input.measuredTicks;
    counts[`${variant}-gzip-bytes-mean`] =
      (counts[`${variant}-gzip-bytes-total`] ?? 0) / input.measuredTicks;
    counts[`${variant}-deflate-bytes-mean`] =
      (counts[`${variant}-deflate-bytes-total`] ?? 0) / input.measuredTicks;
  }
  const unicodeProbe = '🛰️ Δ';
  assert(Buffer.byteLength(unicodeProbe, 'utf8') > unicodeProbe.length);
  return {
    primaryMetric: 'delta-encode-serialize-ms',
    samples,
    counts,
    parameters: input,
    witness: {
      fixture: 'tests/unit/network/snapshotFixture.ts',
      variants: {
        legacy: 'gameState full JSON',
        keyframe: 'snapshot-v1 keyframe',
        delta: 'snapshot-v1 delta',
      },
      utf8ByteSizing: "Buffer.byteLength(payload, 'utf8')",
      unicodeProbe: { value: unicodeProbe, utf8Bytes: Buffer.byteLength(unicodeProbe, 'utf8') },
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    },
    cleanup: 'complete',
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runProtocolExperiment(options());
  validateMeasurement(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
