import type { DebugJsonValue } from '../../shared-types';

type Recording = {
  id: string;
  metadata: { startedAt: string; device: string; conditions: string };
  incompleteReason: string | null;
  samples: readonly string[];
  stopped: boolean;
  recovered: boolean;
};
type Aggregate = {
  count: number;
  sum: number;
  max: number;
  omittedSamples: number;
  over33Ms: number;
  values: number[];
};
const PHASES = ['menu', 'play', 'respawn', 'hidden'];
const COUNTER_NAME = /^[a-zA-Z]{1,64}$/u;
const FRAME_INTERVAL_METRICS = new Set([
  'frameIntervalMs',
  'scanFrameIntervalMs',
  'flightFrameIntervalMs',
  'scanEnterFrameIntervalMs',
  'scanWideFrameIntervalMs',
  'scanReturnFrameIntervalMs',
  'unclassifiedFrameIntervalMs',
]);
const METRICS = new Set([
  ...FRAME_INTERVAL_METRICS,
  'updateMs',
  'renderMs',
  'frameCpuMs',
  'scanUpdateMs',
  'scanRenderMs',
  'scanFrameCpuMs',
  'scanParseMs',
  'scanKeyframeDecodeMs',
  'scanDeltaDecodeMs',
  'scanApplyMs',
  'scanSceneryBuildMs',
  'simpleScanRasterBuildMs',
  'simpleScanTerrainBuildMs',
  'inputToRenderMs',
  'rttMs',
  'messageGapMs',
  'collectionGapMs',
  'parseMs',
  'keyframeDecodeMs',
  'deltaDecodeMs',
  'applyMs',
]);
const GRAPHICS_KEYS = [
  'deviceDpr',
  'effectiveDpr',
  'flightEffectiveDpr',
  'maxDpr',
  'glow',
  'source',
  'touchControls',
  'cssWidth',
  'cssHeight',
  'backingWidth',
  'backingHeight',
  'flightBackingWidth',
  'flightBackingHeight',
  'scanScenery',
  'scanSceneryMaxPixels',
  'deviceCategory',
  'scanDetail',
  'scanDetailReason',
  'scanDeviceMemory',
  'scanLogicalCores',
  'simpleScanDprCap',
  'simpleScanPixelCap',
  'simpleScanMaxDimension',
  'presentationPolicy',
];
const SLOW_FRAME_LIMIT = 16;
const SCENERY_FALLBACK_REASONS = [
  'source',
  'coverage',
  'pixel-limit',
  'dimension-limit',
  'allocation',
  'paint',
  'composite',
  'unsupported',
  'backend',
  'disabled',
];

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid recording object');
  }
  return Object.fromEntries(Object.entries(value));
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid recording number');
  }
  return value;
}

function count(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error('Invalid recording count');
  }
  return result;
}

function settings(value: unknown): Record<string, DebugJsonValue> {
  const result: Record<string, DebugJsonValue> = {};
  const input = object(value);
  for (const key of GRAPHICS_KEYS) {
    const child = input[key];
    if (child === undefined) {
      continue;
    }
    if (typeof child === 'string') {
      result[key] = child.slice(0, 512);
    } else if (typeof child === 'boolean') {
      result[key] = child;
    } else {
      result[key] = number(child);
    }
  }
  return result;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    throw new Error('Missing recording provenance');
  }
  return value.slice(0, limit);
}

function sceneryFrame(value: unknown): Record<string, DebugJsonValue> {
  const row = object(value);
  const kind = row['kind'];
  if (kind === 'native' || kind === 'cached') {
    return { kind };
  }
  if (kind === 'built' && (row['cause'] === 'cold' || row['cause'] === 'pan')) {
    return { kind, cause: row['cause'] };
  }
  if (
    kind === 'fallback' &&
    typeof row['reason'] === 'string' &&
    SCENERY_FALLBACK_REASONS.includes(row['reason'])
  ) {
    return { kind, reason: row['reason'] };
  }
  throw new Error('Invalid scenery frame');
}

function previousFrame(value: unknown) {
  if (value === null) {
    return null;
  }
  const row = object(value);
  const stage = row['stage'];
  if (stage !== 'flight' && stage !== 'enter' && stage !== 'wide' && stage !== 'return') {
    throw new Error('Invalid scan stage');
  }
  return {
    stage,
    scenery: sceneryFrame(row['scenery']),
    visibleSpiders: count(row['visibleSpiders']),
    updateMs: number(row['updateMs']),
    renderMs: number(row['renderMs']),
    frameCpuMs: number(row['frameCpuMs']),
  };
}

function slowFrame(value: unknown) {
  const row = object(value);
  const intervalMs = number(row['intervalMs']);
  if (intervalMs <= 25) {
    throw new Error('Invalid slow-frame interval');
  }
  return {
    atMs: number(row['atMs']),
    intervalMs,
    previousFrame: previousFrame(row['previousFrame']),
  };
}

function presentation(value: unknown): Record<string, DebugJsonValue> {
  const row = object(value);
  if (row['mode'] !== 'flight' && row['mode'] !== 'simple-scan') {
    throw new Error('Invalid presentation mode');
  }
  const stage = row['stage'];
  if (stage !== 'flight' && stage !== 'enter' && stage !== 'wide' && stage !== 'return') {
    throw new Error('Invalid presentation stage');
  }
  return {
    mode: row['mode'],
    stage,
    cssWidth: number(row['cssWidth']),
    cssHeight: number(row['cssHeight']),
    backingWidth: count(row['backingWidth']),
    backingHeight: count(row['backingHeight']),
    dprX: number(row['dprX']),
    dprY: number(row['dprY']),
  };
}

/** Reads existing chunks only when a report opens. Recording and raw exports stay untouched. */
export function summarizePhoneRecording(recording: Recording): Record<string, DebugJsonValue> {
  const reasons = new Set<string>();
  if (!recording.stopped) {
    reasons.add('Recording has not been stopped');
  }
  if (recording.incompleteReason !== null && recording.incompleteReason !== '') {
    reasons.add(recording.incompleteReason.slice(0, 256));
  }
  if (recording.samples.length === 0) {
    reasons.add('No recorded samples');
  }
  const aggregates = new Map<string, Aggregate>();
  const phaseDurations: Record<string, DebugJsonValue> = {};
  const counters: Record<string, DebugJsonValue> = {};
  let durationMs = 0;
  let provenance: Record<string, DebugJsonValue> | null = null;
  let provenanceKey = '';
  const rendererFrames = { canvas: 0, webgl2: 0 };
  const slowFrames: ReturnType<typeof slowFrame>[] = [];
  let slowFrameChunks = 0;
  let observedSlowIntervals = 0;
  const observedPresentations = new Map<string, Record<string, DebugJsonValue>>();
  let omittedPresentationStates = 0;
  let observedPresentationCount = 0;
  for (const serialized of recording.samples) {
    const sample = object(JSON.parse(serialized));
    durationMs += number(sample['durationMs']);
    const phases = object(sample['phaseDurationsMs']);
    for (const phase of PHASES) {
      phaseDurations[phase] = number(number(phaseDurations[phase] ?? 0) + number(phases[phase]));
    }
    const renderer = object(sample['renderer']);
    const frames = object(renderer['frames']);
    rendererFrames.canvas = count(rendererFrames.canvas + count(frames['canvas']));
    rendererFrames.webgl2 = count(rendererFrames.webgl2 + count(frames['webgl2']));
    if (sample['slowFrames'] !== undefined) {
      const context = object(sample['slowFrames']);
      const observed = count(context['observedCount']);
      const values = context['values'];
      if (
        context['limit'] !== SLOW_FRAME_LIMIT ||
        !Array.isArray(values) ||
        values.length !== Math.min(observed, SLOW_FRAME_LIMIT)
      ) {
        throw new Error('Invalid slow-frame selection');
      }
      slowFrameChunks++;
      observedSlowIntervals = count(observedSlowIntervals + observed);
      for (const value of values) {
        slowFrames.push(slowFrame(value));
        slowFrames.sort(
          (left, right) => right.intervalMs - left.intervalMs || left.atMs - right.atMs
        );
        slowFrames.length = Math.min(SLOW_FRAME_LIMIT, slowFrames.length);
      }
    }
    if (
      sample['graphicsPolicyChanges'] !== undefined &&
      count(sample['graphicsPolicyChanges']) > 0
    ) {
      reasons.add('Release, graphics, or renderer changed during recording');
    }
    if (sample['presentationStates'] !== undefined) {
      const states = object(sample['presentationStates']);
      const values = states['values'];
      const observed = count(states['observedCount']);
      const omitted = count(states['omittedStates']);
      if (
        states['limit'] !== 16 ||
        !Array.isArray(values) ||
        values.length > 16 ||
        observed !== values.length + omitted
      ) {
        throw new Error('Invalid presentation states');
      }
      observedPresentationCount += observed;
      omittedPresentationStates += omitted;
      for (const value of values) {
        const state = presentation(value);
        const key = JSON.stringify(state);
        if (!observedPresentations.has(key)) {
          if (observedPresentations.size < 32) {
            observedPresentations.set(key, state);
          } else {
            omittedPresentationStates++;
          }
        }
      }
    }
    const current = {
      clientReleaseId: text(sample['clientReleaseId'], 128),
      serverReleaseId: text(sample['serverReleaseId'], 128),
      graphics: settings(sample['graphicsSettings']),
      rendererRequested: text(renderer['requested'], 32),
      rendererBackend: text(renderer['backend'], 32),
    };
    const currentProvenanceKey = JSON.stringify(current);
    if (provenance === null) {
      provenance = current;
      provenanceKey = currentProvenanceKey;
    } else if (currentProvenanceKey !== provenanceKey) {
      reasons.add('Release, graphics, or renderer changed during recording');
    }
    for (const [key, value] of Object.entries(object(sample['counters']))) {
      if (!COUNTER_NAME.test(key)) {
        throw new Error('Invalid counter');
      }
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new Error('Invalid counter');
      }
      counters[key] = count(number(counters[key] ?? 0) + count(value));
      if (Object.keys(counters).length > 64) {
        throw new Error('Too many counters');
      }
    }
    for (const [key, value] of Object.entries(object(sample['metrics']))) {
      const [phase, metric] = key.split('.');
      if (
        !phase ||
        !metric ||
        key !== `${phase}.${metric}` ||
        !PHASES.includes(phase) ||
        !METRICS.has(metric)
      ) {
        continue;
      }
      const row = object(value);
      const values = row['values'];
      if (!Array.isArray(values) || values.length > 4096) {
        throw new Error('Invalid samples');
      }
      const rowCount = count(row['count']);
      const omitted = count(row['omittedSamples']);
      if (rowCount !== values.length + omitted) {
        throw new Error('Missing samples');
      }
      const aggregate = aggregates.get(key) ?? {
        count: 0,
        sum: 0,
        max: 0,
        omittedSamples: 0,
        over33Ms: 0,
        values: [],
      };
      aggregate.count += rowCount;
      aggregate.sum += number(row['sum']);
      aggregate.max = Math.max(aggregate.max, number(row['max']));
      aggregate.omittedSamples += omitted;
      aggregate.over33Ms += count(row['over33Ms']);
      for (const raw of values) {
        aggregate.values.push(number(raw));
      }
      aggregates.set(key, aggregate);
      if (omitted > 0) {
        reasons.add('Raw metric samples omitted');
      }
    }
    if (object(sample['appliedSnapshots'])['omittedSamples'] !== 0) {
      reasons.add('Applied snapshot samples omitted');
    }
  }
  if ((aggregates.get('play.frameIntervalMs')?.count ?? 0) === 0) {
    reasons.add('No gameplay frame samples');
  }
  const complete = reasons.size === 0;
  const metrics: Record<string, DebugJsonValue> = {};
  for (const [key, aggregate] of aggregates) {
    const sorted = complete ? aggregate.values.toSorted((a, b) => a - b) : [];
    const percentile = (fraction: number) =>
      sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
    metrics[key] = {
      count: count(aggregate.count),
      retainedCount: aggregate.values.length,
      omittedSamples: count(aggregate.omittedSamples),
      sum: number(aggregate.sum),
      mean: aggregate.count > 0 ? aggregate.sum / aggregate.count : null,
      max: aggregate.max,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      over25Ms: complete ? sorted.filter((value) => value > 25).length : null,
      over33Ms: count(aggregate.over33Ms),
      framesPerSecond:
        FRAME_INTERVAL_METRICS.has(key.substring(key.indexOf('.') + 1)) && aggregate.sum > 0
          ? number((1000 * aggregate.count) / aggregate.sum)
          : null,
    };
  }
  const frameCoverageByPhase: Record<string, DebugJsonValue> = {};
  for (const phase of PHASES) {
    const frames = aggregates.get(`${phase}.frameIntervalMs`);
    const phaseDurationMs = number(phaseDurations[phase] ?? 0);
    const completedFrameCount = frames?.count ?? 0;
    const intervalCoverageMs = frames?.sum ?? 0;
    frameCoverageByPhase[phase] = {
      completedFrameCount,
      intervalCoverageMs,
      phaseDurationMs,
      intervalCoverageRatio:
        phaseDurationMs > 0 ? number(intervalCoverageMs / phaseDurationMs) : null,
      fullWindowFramesPerSecond:
        phaseDurationMs > 0 ? number((1000 * completedFrameCount) / phaseDurationMs) : null,
    };
  }
  return {
    schemaVersion: 1,
    source: 'phone-collector',
    sessionId: recording.id.slice(0, 128),
    startedAt: recording.metadata.startedAt.slice(0, 40),
    device: recording.metadata.device.slice(0, 256),
    conditions: recording.metadata.conditions.slice(0, 512),
    stopped: recording.stopped,
    recovered: recording.recovered,
    complete,
    incompleteReasons: [...reasons],
    sampleChunkCount: recording.samples.length,
    durationMs: number(durationMs),
    phaseDurationsMs: phaseDurations,
    frameCoverageByPhase,
    frameRateBasis:
      'Metric framesPerSecond uses completed frame intervals; fullWindowFramesPerSecond uses the whole declared phase duration',
    provenance,
    rendererFrames,
    observedPresentation: {
      selection:
        'Distinct observed presentation states, bounded to 32; not recording policy or a complete frame timeline',
      observedCount: observedPresentationCount,
      omittedStates: omittedPresentationStates,
      values: [...observedPresentations.values()],
    },
    counters,
    slowFrameContext: {
      availability:
        slowFrameChunks === 0
          ? 'unavailable'
          : slowFrameChunks === recording.samples.length
            ? 'complete'
            : 'partial',
      chunksWithContext: slowFrameChunks,
      observedSlowIntervals,
      selectionLimit: SLOW_FRAME_LIMIT,
      selection:
        'Largest recorded intervals over 25 ms; CPU, scan stage, scenery and spiders belong to the preceding completed render. This is not a complete event timeline or GPU timing.',
      values: slowFrames,
    },
    metrics,
    rawSamples: 'Retained locally; this report contains summaries only',
  };
}
