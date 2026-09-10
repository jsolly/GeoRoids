import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateMeasurement } from './results';

export function sampleOptions(kind: string | undefined, seedText = '42', viewport = 'desktop') {
  assert(
    kind === 'client' || kind === 'server' || kind === 'codec' || kind === 'transport',
    'Expected client, server, codec, or transport'
  );
  assert(/^\d+$/.test(seedText), 'seed must be an unsigned 32-bit integer');
  const seed = Number(seedText);
  assert(
    Number.isSafeInteger(seed) && seed <= 0xffff_ffff,
    'seed must be an unsigned 32-bit integer'
  );
  assert(
    viewport === 'desktop' || viewport === 'touch-portrait' || viewport === 'touch-landscape',
    'Unknown viewport'
  );
  assert(kind === 'client' || viewport === 'desktop', 'Only client measurements accept a viewport');
  return { kind, seed, viewport } as const;
}

function parseSampleArguments(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      kind: { type: 'string' },
      seed: { type: 'string' },
      viewport: { type: 'string' },
      output: { type: 'string' },
      failure: { type: 'string' },
    },
  });
  assert(values.output, '--output is required');
  return {
    ...sampleOptions(values.kind, values.seed, values.viewport),
    outputPath: values.output,
    failurePath: values.failure ?? `${values.output}.failure.json`,
  };
}

/** Preserve every cleanup failure, including AggregateError entries and nested causes. */
export function errorRecord(value: unknown, seen = new Set<unknown>()): object {
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
    stack: value.stack,
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
      return runClientSample({
        seed: options.seed,
        viewport: options.viewport,
        warmupFrames: 30,
        measuredFrames: 120,
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
    try {
      await writeJson(options.failurePath, {
        status: 'failed',
        options,
        error: errorRecord(error),
      });
    } catch (artifactError) {
      throw new AggregateError([error, artifactError], 'Sample and failure artifact write failed');
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
