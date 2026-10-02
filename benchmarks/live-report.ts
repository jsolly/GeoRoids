import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { type Measurement, validateMeasurement } from './results';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TRAILING_SLASH_PATTERN = /\/$/u;
const GIT_TIMEOUT_MS = 10_000;
const GIT_PATH_ENVIRONMENT = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
] as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of GIT_PATH_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
}

interface LiveReportMetadata {
  readonly benchmarkVersion: 1;
  readonly git: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly lockfileSha256: string;
    readonly sourceSha256: string;
    readonly productSha256: string;
    readonly harnessSha256: string;
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
      readonly headed?: boolean;
    };
    readonly measurementSource: 'host' | 'emulated-touch' | 'physical-device';
    readonly physicalDevice: boolean;
    readonly gpu?: object;
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
    env: gitEnvironment(),
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
      'scripts',
      'tsconfig',
      'wiki',
      'content',
      'docs/wiki-source-review.json',
      'public',
      'shared-types.ts',
      'server.ts',
      'index.html',
      'index.css',
      'vite.config.ts',
      'tsconfig.build.json',
      'tsconfig.json',
      'tsconfig.benchmarks.json',
      'package.json',
      'package-lock.json',
      'tests/unit/network/snapshotFixture.ts',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: gitEnvironment(),
    }
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
          join(entry.parentPath, entry.name).slice(
            root.replace(TRAILING_SLASH_PATTERN, '').length + 1
          )
        )
    : [];
  const isHarness = (path: string) =>
    path.startsWith('benchmarks/') ||
    path.startsWith('scripts/') ||
    path.startsWith('tests/') ||
    path.startsWith('tsconfig') ||
    ['vite.config.ts', 'package.json', 'package-lock.json'].includes(path);
  return {
    sourceSha256: digest(paths),
    productSha256: digest(paths.filter((path) => !isHarness(path))),
    harnessSha256: digest(paths.filter(isHarness)),
    buildSha256: digest(buildPaths),
  };
}

export function collectLiveReportMetadata(
  options: {
    root?: string;
    browser?: { name: string; version: string; launchFlags?: readonly string[]; headed?: boolean };
    measurementSource?: LiveReportMetadata['environment']['measurementSource'];
    gpu?: object;
  } = {}
): LiveReportMetadata {
  const root = options.root ?? ROOT;
  const dirty = command(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '';
  const browser = options.browser
    ? {
        name: options.browser.name,
        version: options.browser.version,
        launchFlags: [...(options.browser.launchFlags ?? [])],
        ...(options.browser.headed !== undefined ? { headed: options.browser.headed } : {}),
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
      ...(options.gpu ? { gpu: options.gpu } : {}),
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
  await mkdir(dirname(path), { recursive: true });
  const finalHashes = liveInputHashes();
  const drift =
    finalHashes.sourceSha256 !== report.metadata.git.sourceSha256 ||
    finalHashes.buildSha256 !== report.metadata.git.buildSha256;
  // Scenario callbacks retain their diagnostics arrays through teardown. Read
  // them at serialization, after the final asynchronous preparation, rather
  // than trusting a status computed before those callbacks have finished.
  const finalized = finalizeRecordedDiagnostics(report.details);
  let validationError: unknown;
  try {
    if (finalized.failure) {
      throw finalized.failure;
    }
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
  const measurement =
    report.measurement && finalized.scenarioCounts
      ? {
          ...report.measurement,
          counts: { ...report.measurement.counts, ...finalized.scenarioCounts },
        }
      : report.measurement;
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...report,
        status: validationError ? 'failed' : report.status,
        details: finalized.details,
        ...(measurement ? { measurement } : {}),
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

function diagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (value && typeof value === 'object' && 'message' in value) {
    return String(value.message);
  }
  return String(value);
}

function finalizeRecordedDiagnostics(details: Record<string, unknown>): {
  details: Record<string, unknown>;
  failure?: Error;
  scenarioCounts?: { successfulScenarios: number; failedScenarios: number };
} {
  const failures: string[] = [];
  function inspect(value: Record<string, unknown>, label: string): boolean {
    const before = failures.length;
    for (const field of ['errors', 'warnings', 'failures']) {
      const diagnostics = value[field];
      if (diagnostics === undefined) {
        continue;
      }
      if (!Array.isArray(diagnostics)) {
        failures.push(`${label}.${field} is not a diagnostics array`);
      } else if (diagnostics.length > 0) {
        failures.push(`${label}.${field}: ${diagnostics.map(diagnosticText).join('; ')}`);
      }
    }
    if (value['cleanupComplete'] === false) {
      failures.push(`${label} cleanup is incomplete`);
    }
    return failures.length !== before;
  }
  inspect(details, 'Benchmark');
  const recordedScenarios = details['scenarios'];
  let scenarioCounts: { successfulScenarios: number; failedScenarios: number } | undefined;
  let finalizedDetails = details;
  if (recordedScenarios !== undefined) {
    if (!Array.isArray(recordedScenarios)) {
      failures.push('Benchmark.scenarios is not an array');
    } else {
      let successfulScenarios = 0;
      let failedScenarios = 0;
      const scenarios = recordedScenarios.map((scenario: unknown, index: number) => {
        const label = `Scenario ${index + 1}`;
        if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
          failures.push(`${label} is not a scenario record`);
          failedScenarios++;
          return scenario;
        }
        const record = scenario as Record<string, unknown>;
        const diagnosticsFailed = inspect(record, label);
        const status = record['status'];
        if (status === 'failed') {
          failures.push(`${label} failed: ${diagnosticText(record['failure'] ?? 'See scenario')}`);
        } else if (status !== 'passed') {
          failures.push(`${label} has an invalid status`);
        }
        if (diagnosticsFailed || status !== 'passed') {
          failedScenarios++;
          return { ...record, status: 'failed' };
        }
        successfulScenarios++;
        return record;
      });
      finalizedDetails = { ...details, scenarios };
      scenarioCounts = { successfulScenarios, failedScenarios };
    }
  }
  return {
    details: finalizedDetails,
    ...(scenarioCounts ? { scenarioCounts } : {}),
    ...(failures.length
      ? { failure: new Error(`Recorded benchmark failures:\n${failures.join('\n')}`) }
      : {}),
  };
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
