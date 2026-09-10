import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  SNAPSHOT_KEYFRAME_INTERVAL,
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
  type SnapshotFrame,
} from '../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../shared-types';
import { snapshotFixture } from '../tests/unit/network/snapshotFixture';
import type { Measurement } from './results';

const FULL_FIXTURE_KEYS = [
  'asteroids',
  'collabTags',
  'entities',
  'gameTime',
  'isPaused',
  'loot',
  'satellitePickups',
  'satelliteProjectiles',
  'satellites',
  'terrainSeed',
];
const BASELINE_PATTERNS: readonly BaselinePattern[] = ['shared', 'staggered'];
const MAX_RECIPIENTS = 25;

type BaselinePattern = 'shared' | 'staggered';

export interface CodecSampleOptions {
  readonly seed: number;
  readonly warmupTicks: number;
  readonly measuredTicks: number;
  readonly recipientCounts: readonly number[];
}

export const DEFAULT_CODEC_SAMPLE_OPTIONS: CodecSampleOptions = {
  seed: 0,
  warmupTicks: 30,
  measuredTicks: 120,
  recipientCounts: [1, 2, 5, 10, 25],
};

interface RecipientState {
  sequence: number;
  sinceKeyframe: number;
  baseline?: SnapshotBaseline;
}

interface WireMessage {
  readonly recipient: number;
  readonly text: string;
}

// Each outer entry is one tick, including ticks with no deliveries.
type FrameTrace = [
  recipient: number,
  sequence: number,
  kind: SnapshotFrame['kind'],
  baseline: number | null,
];

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateOptions(options: CodecSampleOptions): void {
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error('seed must be a safe integer');
  }
  requirePositiveInteger('warmupTicks', options.warmupTicks);
  requirePositiveInteger('measuredTicks', options.measuredTicks);
  if (options.recipientCounts.length === 0) {
    throw new Error('recipientCounts must contain at least one recipient count');
  }
  const distinct = new Set<number>();
  for (const [index, count] of options.recipientCounts.entries()) {
    requirePositiveInteger(`recipientCounts[${index}]`, count);
    if (count > MAX_RECIPIENTS) {
      throw new Error(`recipientCounts[${index}] must be no greater than ${MAX_RECIPIENTS}`);
    }
    if (distinct.has(count)) {
      throw new Error(`recipientCounts contains duplicate count ${count}`);
    }
    distinct.add(count);
  }
  if (!Number.isSafeInteger(options.seed + options.warmupTicks + options.measuredTicks)) {
    throw new Error('seed plus tick count must remain a safe integer');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value['type'] !== 'snapshot' || !Object.hasOwn(value, 'data')) {
    throw new Error('Serialized codec fixture did not contain a snapshot envelope');
  }
  return value['data'];
}

function worlds(options: CodecSampleOptions): ServerGameSnapshot[] {
  const count = options.warmupTicks + options.measuredTicks;
  const result = Array.from({ length: count }, (_, index) => snapshotFixture(options.seed + index));
  for (const [index, world] of result.entries()) {
    assert.deepEqual(
      Object.keys(world).toSorted(),
      FULL_FIXTURE_KEYS,
      `Codec fixture at tick ${index} is missing a complete top-level field set`
    );
  }
  return result;
}

function delivers(pattern: BaselinePattern, tick: number, recipient: number): boolean {
  return pattern === 'shared' || (tick + recipient) % 5 !== 0;
}

function encodeTick(
  world: ServerGameSnapshot,
  tick: number,
  pattern: BaselinePattern,
  state: RecipientState[]
): WireMessage[] {
  const encoder = new SnapshotEncoder(world);
  const messages: WireMessage[] = [];
  for (const [recipient, current] of state.entries()) {
    if (!delivers(pattern, tick, recipient)) {
      continue;
    }
    const sequence = current.sequence + 1;
    const frame = encoder.encode(
      sequence,
      current.sinceKeyframe >= SNAPSHOT_KEYFRAME_INTERVAL ? undefined : current.baseline
    );
    const text = JSON.stringify({ type: 'snapshot', data: frame, timestamp: 0 });
    messages.push({ recipient, text });
    current.sequence = sequence;
    current.sinceKeyframe = frame.kind === 'keyframe' ? 0 : current.sinceKeyframe + 1;
    current.baseline = { sequence, state: encoder.state };
  }
  return messages;
}

function timedEncode(
  fixtureWorlds: readonly ServerGameSnapshot[],
  options: CodecSampleOptions,
  pattern: BaselinePattern,
  recipientCount: number
) {
  const state: RecipientState[] = Array.from({ length: recipientCount }, () => ({
    sequence: 0,
    sinceKeyframe: 0,
  }));
  const history: WireMessage[][] = [];
  const samples: number[] = [];
  // Keep the original expected worlds untouched even if a candidate mutates its inputs.
  const inputs = structuredClone(fixtureWorlds);
  for (const [tick, world] of inputs.entries()) {
    if (tick < options.warmupTicks) {
      history.push(encodeTick(world, tick, pattern, state));
      continue;
    }
    const startedAt = performance.now();
    const messages = encodeTick(world, tick, pattern, state);
    const elapsed = performance.now() - startedAt;
    samples.push(elapsed);
    history.push(messages);
  }
  return { samples, history };
}

function validateHistory(
  history: readonly WireMessage[][],
  fixtureWorlds: readonly ServerGameSnapshot[],
  options: CodecSampleOptions,
  pattern: BaselinePattern,
  recipientCount: number
) {
  assert.equal(history.length, fixtureWorlds.length, 'Incomplete codec wire history');
  const state = Array.from({ length: recipientCount }, () => ({
    sequence: 0,
    sinceKeyframe: 0,
    decoder: new SnapshotDecoder(),
  }));
  const stats = { messages: 0, keyframes: 0, deltas: 0, bytes: 0, validatedMessages: 0 };
  const frameTrace: FrameTrace[][] = [];
  const kinds = new Set<SnapshotFrame['kind']>();
  let baselineDivergenceObserved = false;
  let lastDecodedWorld: ServerGameSnapshot | undefined;
  for (const [tick, world] of fixtureWorlds.entries()) {
    const messages = history[tick];
    assert(messages, `Missing codec wire history at tick ${tick}`);
    assert.deepEqual(
      messages.map((message) => message.recipient),
      state.flatMap((_, recipient) => (delivers(pattern, tick, recipient) ? [recipient] : [])),
      `Codec deliveries changed at tick ${tick}`
    );
    const trace: FrameTrace[] = [];
    for (const message of messages) {
      const recipient = state[message.recipient];
      assert(recipient, `Missing codec recipient ${message.recipient}`);
      const frame = parseEnvelope(message.text);
      const decoded = recipient.decoder.decode(frame);
      assert.deepEqual(decoded, world, 'Codec decode changed the original fixture state');
      assert(isRecord(frame), 'Codec frame must be an object');
      const sequence = frame['sequence'];
      const kind = frame['kind'];
      assert(typeof sequence === 'number' && sequence === recipient.sequence + 1);
      assert(kind === 'keyframe' || kind === 'delta', 'Unsupported codec frame kind');
      if (recipient.sequence === 0 || recipient.sinceKeyframe >= SNAPSHOT_KEYFRAME_INTERVAL) {
        assert.equal(kind, 'keyframe', 'Codec recipient did not receive its required keyframe');
      }
      const baseline = kind === 'delta' ? frame['baseline'] : null;
      assert(baseline === null || typeof baseline === 'number', 'Invalid codec baseline');
      if (kind === 'delta') {
        assert.equal(baseline, recipient.sequence, 'Codec delta changed its recipient baseline');
      }
      trace.push([message.recipient, sequence, kind, baseline]);
      kinds.add(kind);
      recipient.sequence = sequence;
      recipient.sinceKeyframe = kind === 'keyframe' ? 0 : recipient.sinceKeyframe + 1;
      stats.validatedMessages += 1;
      if (tick >= options.warmupTicks) {
        stats.messages += 1;
        stats.bytes += Buffer.byteLength(message.text, 'utf8');
        stats.keyframes += kind === 'keyframe' ? 1 : 0;
        stats.deltas += kind === 'delta' ? 1 : 0;
      }
      lastDecodedWorld = decoded;
    }
    frameTrace.push(trace);
    const divergent = new Set(state.map((recipient) => recipient.sequence)).size > 1;
    assert(pattern !== 'shared' || !divergent, 'Shared codec recipient baselines diverged');
    baselineDivergenceObserved ||= divergent;
  }
  assert(kinds.has('keyframe') && kinds.has('delta'), 'Codec must exercise keyframes and deltas');
  assert(
    pattern !== 'staggered' || recipientCount === 1 || baselineDivergenceObserved,
    'Staggered codec validation did not observe divergent recipient baselines'
  );
  assert(
    state.every((recipient) => recipient.sequence > 0),
    'Codec recipient received no frames'
  );
  assert(lastDecodedWorld, 'Codec validation produced no decoded world');
  return {
    stats,
    lastDecodedWorld,
    witness: {
      pattern,
      recipients: recipientCount,
      finalSequences: state.map((recipient) => recipient.sequence),
      baselineDivergenceObserved,
      frameTrace,
    },
  };
}

function timedDecode(
  history: readonly WireMessage[][],
  options: CodecSampleOptions,
  recipientCount: number
) {
  const decoders = Array.from({ length: recipientCount }, () => new SnapshotDecoder());
  const decode = (batch: readonly WireMessage[]): void => {
    for (const message of batch) {
      const decoder = decoders[message.recipient];
      if (!decoder) {
        throw new Error(`Missing decoder for recipient ${message.recipient}`);
      }
      decoder.decode(parseEnvelope(message.text));
    }
  };
  const samples: number[] = [];
  let messages = 0;
  for (const [tick, batch] of history.entries()) {
    if (tick < options.warmupTicks) {
      decode(batch);
      continue;
    }
    const startedAt = performance.now();
    decode(batch);
    samples.push(performance.now() - startedAt);
    messages += batch.length;
  }
  return { samples, messages };
}

function scenarioKey(pattern: BaselinePattern, recipientsCount: number): string {
  return `${pattern}-recipients-${recipientsCount}`;
}

export function runCodecSample(
  options: CodecSampleOptions = DEFAULT_CODEC_SAMPLE_OPTIONS
): Measurement {
  validateOptions(options);
  const fixtureWorlds = worlds(options);
  const scenarios: ReturnType<typeof validateHistory>['witness'][] = [];
  const samples: Record<string, number[]> = {};
  const counts: Record<string, number> = {
    warmupTicks: options.warmupTicks,
    measuredTicks: options.measuredTicks,
  };
  let lastDecodedWorld: ServerGameSnapshot | undefined;
  for (const pattern of BASELINE_PATTERNS) {
    for (const recipientCount of options.recipientCounts) {
      const encoded = timedEncode(fixtureWorlds, options, pattern, recipientCount);
      const validation = validateHistory(
        encoded.history,
        fixtureWorlds,
        options,
        pattern,
        recipientCount
      );
      const decoded = timedDecode(encoded.history, options, recipientCount);
      assert.equal(
        decoded.messages,
        validation.stats.messages,
        'Measured encode/decode work differs'
      );
      scenarios.push(validation.witness);
      lastDecodedWorld = validation.lastDecodedWorld;
      const key = scenarioKey(pattern, recipientCount);
      samples[`${key}-encode-serialize-ms`] = encoded.samples;
      samples[`${key}-decode-ms`] = decoded.samples;
      counts[`${key}-messages`] = validation.stats.messages;
      counts[`${key}-keyframes`] = validation.stats.keyframes;
      counts[`${key}-deltas`] = validation.stats.deltas;
      counts[`${key}-utf8-application-bytes`] = validation.stats.bytes;
      counts[`${key}-decoded-messages`] = decoded.messages;
      counts[`${key}-validated-messages`] = validation.stats.validatedMessages;
    }
  }
  const firstRecipientCount = options.recipientCounts[0];
  const firstWorld = fixtureWorlds[0];
  assert(firstRecipientCount !== undefined && firstWorld && lastDecodedWorld);
  return {
    primaryMetric: `${scenarioKey('shared', firstRecipientCount)}-encode-serialize-ms`,
    samples,
    counts,
    witness: {
      before: { firstWorld: structuredClone(firstWorld), fixtureKeys: FULL_FIXTURE_KEYS },
      after: { lastDecodedWorld: structuredClone(lastDecodedWorld), scenarios },
    },
    parameters: options,
    cleanup: 'complete',
  };
}
