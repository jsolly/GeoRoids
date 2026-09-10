import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Measurement, validateMeasurement } from './results';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GIT_TIMEOUT_MS = 10_000;

interface LiveReportMetadata {
  readonly benchmarkVersion: 1;
  readonly git: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly lockfileSha256: string;
    readonly sourceSha256: string;
    readonly buildSha256: string;
  };
  readonly environment: {
    readonly nodeVersion: string;
    readonly os: string;
    readonly osRelease: string;
    readonly arch: string;
    readonly cpuModel: string;
    readonly browser?: {
      readonly name: string;
      readonly version: string;
      readonly launchFlags: readonly string[];
    };
    readonly measurementSource: 'host' | 'emulated-touch' | 'physical-device';
    readonly physicalDevice: boolean;
  };
}

interface LiveReport<TDetails extends object = Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly kind: 'realtime-client' | 'websocket-load';
  readonly status: 'passed' | 'failed';
  readonly metadata: LiveReportMetadata;
  readonly measurement?: Measurement;
  readonly details: TDetails;
}

function command(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }).trim();
}

function lockfileSha256(root: string): string {
  return createHash('sha256')
    .update(readFileSync(join(root, 'package-lock.json')))
    .digest('hex');
}

function liveInputHashes(root = ROOT) {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'src',
      'shared',
      'server',
      'setup',
      'benchmarks',
      'public',
      'shared-types.ts',
      'server.ts',
      'index.html',
      'index.css',
      'vite.config.ts',
      'package.json',
      'package-lock.json',
      'tests/unit/network/snapshotFixture.ts',
    ],
    { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }
  )
    .split('\0')
    .filter(Boolean);
  function digest(files: string[]) {
    const hash = createHash('sha256');
    for (const path of [...new Set(files)].sort()) {
      hash.update(path).update('\0');
      hash.update(existsSync(join(root, path)) ? readFileSync(join(root, path)) : '<deleted>');
      hash.update('\0');
    }
    return hash.digest('hex');
  }
  const buildPaths = existsSync(join(root, 'dist'))
    ? readdirSync(join(root, 'dist'), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          join(entry.parentPath, entry.name).slice(root.replace(/\/$/, '').length + 1)
        )
    : [];
  return { sourceSha256: digest(paths), buildSha256: digest(buildPaths) };
}

export function collectLiveReportMetadata(
  options: {
    root?: string;
    browser?: { name: string; version: string; launchFlags?: readonly string[] };
    measurementSource?: LiveReportMetadata['environment']['measurementSource'];
  } = {}
): LiveReportMetadata {
  const root = options.root ?? ROOT;
  const dirty = command(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '';
  const browser = options.browser
    ? {
        name: options.browser.name,
        version: options.browser.version,
        launchFlags: [...(options.browser.launchFlags ?? [])],
      }
    : undefined;
  return {
    benchmarkVersion: 1,
    git: {
      commit: command(root, ['rev-parse', 'HEAD']),
      dirty,
      lockfileSha256: lockfileSha256(root),
      ...liveInputHashes(root),
    },
    environment: {
      nodeVersion: process.version,
      os: platform(),
      osRelease: release(),
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      ...(browser ? { browser } : {}),
      measurementSource: options.measurementSource ?? 'host',
      physicalDevice: options.measurementSource === 'physical-device',
    },
  };
}

export function createLiveReport<TDetails extends object>(options: {
  kind: LiveReport['kind'];
  measurement?: Measurement;
  details: TDetails;
  failed?: boolean;
  metadata: LiveReportMetadata;
}): LiveReport<TDetails> {
  return {
    schemaVersion: 1,
    kind: options.kind,
    status: options.failed ? 'failed' : 'passed',
    metadata: options.metadata,
    ...(options.measurement ? { measurement: options.measurement } : {}),
    details: options.details,
  };
}

export async function writeLiveReport(path: string, report: LiveReport): Promise<void> {
  const finalHashes = liveInputHashes();
  const drift =
    finalHashes.sourceSha256 !== report.metadata.git.sourceSha256 ||
    finalHashes.buildSha256 !== report.metadata.git.buildSha256;
  let validationError: unknown;
  try {
    if (report.measurement) {
      validateMeasurement(report.measurement);
    } else if (report.status === 'passed') {
      throw new Error('Passing report requires measurements');
    }
    if (drift) {
      throw new Error('Benchmark source or built client changed during the session');
    }
  } catch (error) {
    validationError = error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...report,
        status: validationError ? 'failed' : report.status,
        finalHashes,
        ...(validationError ? { validationFailure: errorRecord(validationError) } : {}),
      },
      null,
      2
    )}\n`
  );
  if (validationError) {
    throw validationError;
  }
}

export function validateHealth(value: unknown): void {
  if (!value || typeof value !== 'object' || !('status' in value) || value.status !== 'healthy') {
    throw new Error('Server health JSON is not healthy');
  }
  if (
    !('metrics' in value) ||
    !value.metrics ||
    typeof value.metrics !== 'object' ||
    !('histograms' in value.metrics) ||
    !value.metrics.histograms ||
    typeof value.metrics.histograms !== 'object' ||
    !('tickDurationMs' in value.metrics.histograms)
  ) {
    throw new Error('Server tick metrics missing; enable GEOROIDS_PERFORMANCE=1');
  }
  const tick = value.metrics.histograms.tickDurationMs;
  if (
    !tick ||
    typeof tick !== 'object' ||
    !('count' in tick) ||
    typeof tick.count !== 'number' ||
    !Number.isSafeInteger(tick.count) ||
    tick.count < 0
  ) {
    throw new Error('Invalid server tick sample count');
  }
  if (
    'counters' in value.metrics &&
    value.metrics.counters &&
    typeof value.metrics.counters === 'object' &&
    'invalidMetricSamples' in value.metrics.counters &&
    value.metrics.counters.invalidMetricSamples !== 0
  ) {
    throw new Error('Server recorded invalid metric samples');
  }
}

export function errorRecord(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  return { name: 'Error', message: String(value) };
}
