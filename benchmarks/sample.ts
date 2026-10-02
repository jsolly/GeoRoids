import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clientSceneTraits, isClientScene } from './client-scenes';
import { validateMeasurement } from './results';

const UNSIGNED_INT_PATTERN = /^\d+$/u;

export function sampleOptions(
  kind: string | undefined,
  seedText = '42',
  viewport = 'desktop',
  renderer = 'canvas',
  dprText = '1',
  chromiumGpu = false,
  scene?: string
) {
  assert(
    kind === 'client' ||
      kind === 'server' ||
      kind === 'codec' ||
      kind === 'transport' ||
      kind === 'wire-ledger',
    'Expected client, server, codec, transport, or wire-ledger'
  );
  assert(UNSIGNED_INT_PATTERN.test(seedText), 'seed must be an unsigned 32-bit integer');
  const seed = Number(seedText);
  assert(
    Number.isSafeInteger(seed) && seed <= 0xffff_ffff,
    'seed must be an unsigned 32-bit integer'
  );
  assert(
    viewport === 'desktop' ||
      viewport === 'touch-portrait' ||
      viewport === 'touch-landscape' ||
      viewport === 'tablet',
    'Unknown viewport'
  );
  assert(kind === 'client' || viewport === 'desktop', 'Only client measurements accept a viewport');
  assert(renderer === 'canvas' || renderer === 'webgl2', 'Unknown renderer');
  const dpr = Number(dprText);
  assert(Number.isFinite(dpr) && dpr >= 1 && dpr <= 4, 'dpr must be 1..4');
  assert(
    kind === 'client' || (renderer === 'canvas' && dpr === 1 && !chromiumGpu),
    'Only client measurements accept graphics options'
  );
  assert(kind === 'client' || scene === undefined, 'Only client measurements accept a scene');
  const clientScene = scene ?? 'stationary';
  assert(isClientScene(clientScene), 'Unknown client scene');
  return { kind, seed, viewport, renderer, dpr, chromiumGpu, scene: clientScene } as const;
}

export function parseSampleArguments(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      kind: { type: 'string' },
      seed: { type: 'string' },
      viewport: { type: 'string' },
      renderer: { type: 'string' },
      scene: { type: 'string' },
      dpr: { type: 'string' },
      'chromium-gpu': { type: 'boolean', default: false },
      output: { type: 'string' },
      failure: { type: 'string' },
    },
  });
  assert(values.output, '--output is required');
  return {
    ...sampleOptions(
      values.kind,
      values.seed,
      values.viewport,
      values.renderer,
      values.dpr,
      values['chromium-gpu'],
      values.scene
    ),
    outputPath: values.output,
    failurePath: values.failure ?? `${values.output}.failure.json`,
  };
}

type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
  errors?: SerializedError[];
};

/** Preserve every cleanup failure, including AggregateError entries and nested causes. */
export function errorRecord(value: unknown, seen = new Set<unknown>()): SerializedError {
  if (!(value instanceof Error)) {
    return { message: String(value) };
  }
  if (seen.has(value)) {
    return { message: '[circular error]' };
  }
  seen.add(value);
  return {
    name: value.name,
    message: value.message,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
    ...(value.cause === undefined ? {} : { cause: errorRecord(value.cause, seen) }),
    ...(value instanceof AggregateError
      ? { errors: Array.from(value.errors, (error: unknown) => errorRecord(error, seen)) }
      : {}),
  };
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

async function executeSample(options: ReturnType<typeof sampleOptions>) {
  switch (options.kind) {
    case 'client': {
      const { runClientSample } = await import('./client');
      const traits = clientSceneTraits(options.scene);
      return runClientSample({
        seed: options.seed,
        viewport: options.viewport,
        warmupFrames: traits.warmupFrames,
        measuredFrames: traits.measuredFrames,
        scene: options.scene,
        renderer: options.renderer,
        dpr: options.dpr,
        chromiumGpu: options.chromiumGpu,
      });
    }
    case 'server': {
      const { runServerSample, DEFAULT_SERVER_SAMPLE_OPTIONS } = await import('./server');
      return runServerSample({ ...DEFAULT_SERVER_SAMPLE_OPTIONS, seed: options.seed });
    }
    case 'codec': {
      const { runCodecSample, DEFAULT_CODEC_SAMPLE_OPTIONS } = await import('./codec');
      return runCodecSample({ ...DEFAULT_CODEC_SAMPLE_OPTIONS, seed: options.seed });
    }
    case 'transport': {
      const { runTransportSample, DEFAULT_TRANSPORT_SAMPLE_OPTIONS } = await import('./transport');
      return runTransportSample({ ...DEFAULT_TRANSPORT_SAMPLE_OPTIONS, seed: options.seed });
    }
    case 'wire-ledger': {
      const { runWireLedgerSample, DEFAULT_WIRE_LEDGER_OPTIONS } = await import('./wire-ledger');
      return runWireLedgerSample({ ...DEFAULT_WIRE_LEDGER_OPTIONS, seed: options.seed });
    }
    default: {
      const exhaustive: never = options.kind;
      throw new Error(`Unsupported kind: ${exhaustive}`);
    }
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)) {
  const options = parseSampleArguments(argv);
  try {
    const result: unknown = await executeSample(options);
    validateMeasurement(result);
    await writeJson(options.outputPath, result);
  } catch (error) {
    let artifactError: unknown;
    try {
      await writeJson(options.failurePath, {
        status: 'failed',
        options,
        error: errorRecord(error),
        ...(error instanceof Error && 'wireEvidence' in error
          ? { wireEvidence: error.wireEvidence }
          : {}),
      });
    } catch (writeError) {
      artifactError = writeError;
    }
    if (artifactError) {
      const artifactMessage =
        artifactError instanceof Error ? artifactError.message : 'unknown artifact failure';
      throw new Error(`Sample and failure artifact write failed (${artifactMessage})`, {
        cause: error,
      });
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorRecord(error))}\n`);
    process.exitCode = 1;
  }
}
