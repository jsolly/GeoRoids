import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  canonicalJson,
  compareMeasurements,
  type MeasurementPair,
  validateMeasurement,
} from './results';
import { errorRecord, sampleOptions, writeJson } from './sample';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
type Command =
  | { mode: 'measure'; revision: string }
  | { mode: 'compare'; baseline: string; candidate: string };

const HARNESS_PATHS = ['benchmarks', 'tests/unit/network/snapshotFixture.ts'];
const GENERATED = new Set(['.git', 'node_modules', 'logs', 'dist', 'coverage', '.cache', '.vite']);

function parseArguments(argv: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      revision: { type: 'string' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      seed: { type: 'string' },
      viewport: { type: 'string' },
    },
  });
  assert.equal(positionals.length, 2, 'Usage: benchmark <measure|compare> <kind> [options]');
  const options = sampleOptions(positionals[1], values.seed, values.viewport);
  const mode = positionals[0];
  if (mode === 'measure') {
    assert(
      values.revision && !values.baseline && !values.candidate,
      'measure requires only --revision'
    );
    const command: Command = { mode, revision: values.revision };
    return { ...options, command };
  }
  assert(mode === 'compare', 'Expected measure or compare');
  assert(options.kind !== 'transport', 'Transport is single-revision only');
  assert(
    values.baseline && values.candidate && !values.revision,
    'compare requires --baseline and --candidate'
  );
  const command: Command = { mode, baseline: values.baseline, candidate: values.candidate };
  return { ...options, command };
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

/** Logs go straight to exclusive files; an aborted command cannot leave its process group running. */
export function commands(directory: string, signal: AbortSignal) {
  let sequence = 0;
  return async (
    program: string,
    args: string[],
    cwd = ROOT,
    timeoutMs = 30_000,
    allowNonZero = false
  ) => {
    signal.throwIfAborted();
    const prefix = join(directory, `command-${++sequence}`);
    const stdout = await open(`${prefix}.stdout.log`, 'wx');
    const stderr = await open(`${prefix}.stderr.log`, 'wx');
    const failures: unknown[] = [];
    const child = spawn(program, args, {
      cwd,
      detached: true,
      stdio: ['ignore', stdout.fd, stderr.fd],
      env: {
        ...process.env,
        CI: '1',
        NODE_ENV: 'production',
        SERVER_LOG_LEVEL: 'error',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });
    try {
      const [code, exitSignal] = await once(child, 'exit', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      assert(
        exitSignal === null && (allowNonZero || code === 0),
        `${program} exited with ${code ?? exitSignal}`
      );
      assert(!child.pid || !signalGroup(child.pid, 0), `${program} left child processes running`);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (child.pid && signalGroup(child.pid, 'SIGTERM')) {
          const gracefulDeadline = Date.now() + 2_000;
          while (signalGroup(child.pid, 0) && Date.now() < gracefulDeadline) {
            await delay(20);
          }
          if (signalGroup(child.pid, 0)) {
            const exited =
              child.exitCode === null && child.signalCode === null
                ? once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
                : Promise.resolve();
            signalGroup(child.pid, 'SIGKILL');
            await exited;
            const forcedDeadline = Date.now() + 10_000;
            while (signalGroup(child.pid, 0)) {
              assert(Date.now() < forcedDeadline, `Process group ${child.pid} survived SIGKILL`);
              await delay(20);
            }
          }
        }
      } catch (error) {
        failures.push(error);
      }
      await stdout.close();
      await stderr.close();
      await writeJson(`${prefix}.json`, {
        program,
        args,
        cwd,
        timeoutMs,
        exitCode: child.exitCode,
        signal: child.signalCode,
        errors: failures.map((error) => errorRecord(error)),
      });
    }
    if (failures.length) {
      throw new AggregateError(failures, `Command failed; logs: ${prefix}`);
    }
    return { code: child.exitCode, stdout: await readFile(`${prefix}.stdout.log`, 'utf8') };
  };
}

type RunCommand = ReturnType<typeof commands>;

async function revision(input: string, command: RunCommand) {
  assert(input && !input.startsWith('-'), 'Invalid Git revision');
  const commit = (
    await command('git', ['rev-parse', '--verify', '--end-of-options', `${input}^{commit}`])
  ).stdout.trim();
  assert(/^[0-9a-f]{40}$/.test(commit), 'Expected a Git commit SHA');
  const tree = (await command('git', ['rev-parse', '--verify', `${commit}^{tree}`])).stdout.trim();
  return { input, commit, tree };
}

async function harnessState(command: RunCommand) {
  const pinned = await revision('HEAD', command);
  const { stdout: status } = await command('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  assert.equal(status, '', 'Benchmark harness must be clean and committed');
  return { ...pinned, sourceHash: await sourceHash(ROOT) };
}

async function sourceHash(root: string, excluded = GENERATED): Promise<string> {
  const hash = createHash('sha256');
  async function visit(relative: string) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).toSorted(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      if (!relative && excluded.has(entry.name)) {
        continue;
      }
      const path = join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${path}\0${await readlink(join(root, path))}\0`);
      } else {
        assert(entry.isFile(), `Unsupported source entry: ${path}`);
        const bytes = await readFile(join(root, path));
        hash.update(`file\0${path}\0${bytes.length}\0`).update(bytes);
      }
    }
  }
  await visit('');
  return hash.digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown) {
  assert(isObject(value), 'Expected JSON object');
  return value;
}

/** npm checks the installed graph; the hidden lock also pins each installed package to our lock. */
async function verifyDependencies(command: RunCommand, directory: string) {
  // Invalid dependencies allow npm ci; a process timeout or failed cleanup still fails the run.
  const graph = await command(
    'npm',
    ['ls', '--all', '--include=dev', '--json'],
    ROOT,
    120_000,
    true
  );
  try {
    assert.equal(graph.code, 0, 'Installed npm dependency graph is invalid');
    const locked = object(
      object(JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8')))['packages']
    );
    const installed = object(
      object(JSON.parse(await readFile(join(ROOT, 'node_modules/.package-lock.json'), 'utf8')))[
        'packages'
      ]
    );
    for (const [path, metadata] of Object.entries(installed)) {
      assert(
        path.startsWith('node_modules/') && !path.split('/').includes('..'),
        'Invalid installed package path'
      );
      const expected = object(locked[path]);
      const actual = object(metadata);
      for (const key of ['version', 'resolved', 'integrity']) {
        assert.equal(actual[key], expected[key], `${path}: ${key} differs from lock`);
      }
      const manifest = object(JSON.parse(await readFile(join(ROOT, path, 'package.json'), 'utf8')));
      assert.equal(
        manifest['version'],
        expected['version'],
        `${path}: installed version differs from lock`
      );
    }
    return true;
  } catch (error) {
    await writeJson(join(directory, 'dependency-link-rejected.json'), errorRecord(error));
    return false;
  }
}

async function prepareRuntime(options: {
  directory: string;
  label: string;
  product: Awaited<ReturnType<typeof revision>>;
  harness: Awaited<ReturnType<typeof harnessState>>;
  command: RunCommand;
  canLink: boolean;
}) {
  const { directory, label, product, harness, command, canLink } = options;
  const path = join(directory, label);
  await mkdir(path);
  await command(
    'git',
    ['archive', '--format=tar', `--output=${directory}/${label}.tar`, product.commit],
    ROOT,
    120_000
  );
  await command('tar', ['-xf', `${directory}/${label}.tar`, '-C', path], ROOT, 120_000);
  // Remove the product's historical harness before overlaying the one pinned implementation.
  await rm(join(path, 'benchmarks'), { recursive: true, force: true });
  await command('tar', ['-xf', `${directory}/harness.tar`, '-C', path], ROOT, 120_000);
  const before = await sourceHash(path);
  const lock = await readFile(join(path, 'package-lock.json'));
  const link = canLink && lock.equals(await readFile(join(ROOT, 'package-lock.json')));
  const runtime = {
    label,
    path,
    product,
    harnessCommit: harness.commit,
    dependencyMode: link ? 'verified-installed-link' : 'npm-ci',
    packageLockSha256: createHash('sha256').update(lock).digest('hex'),
    sourceHash: before,
  };
  await writeJson(join(directory, `${label}.setup.json`), runtime);
  const failures: unknown[] = [];
  try {
    if (link) {
      await symlink(join(ROOT, 'node_modules'), join(path, 'node_modules'), 'dir');
    } else {
      await command('npm', ['ci', '--include=dev'], path, 600_000);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const after = await sourceHash(path);
    await writeJson(join(directory, `${label}.setup-hash.json`), { before, after });
    assert.equal(after, before, 'Dependency setup mutated archived source');
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, `${label} setup failed`);
  }
  return { ...runtime, dependenciesHash: await sourceHash(join(path, 'node_modules'), new Set()) };
}

async function measure(
  runtime: Awaited<ReturnType<typeof prepareRuntime>>,
  id: string,
  options: ReturnType<typeof parseArguments>,
  directory: string,
  command: RunCommand
) {
  const output = join(directory, `${id}.json`);
  const args = [
    '--import',
    'tsx',
    'benchmarks/sample.ts',
    '--kind',
    options.kind,
    '--seed',
    String(options.seed),
    '--viewport',
    options.viewport,
    '--output',
    output,
  ];
  await writeJson(join(directory, `${id}.metadata.json`), {
    id,
    product: runtime.product,
    harnessCommit: runtime.harnessCommit,
    args,
    cwd: runtime.path,
  });
  await command(process.execPath, args, runtime.path, 300_000);
  const result: unknown = JSON.parse(await readFile(output, 'utf8'));
  validateMeasurement(result);
  if (options.kind === 'client') {
    assert(
      'browserVersion' in result.parameters && typeof result.parameters.browserVersion === 'string',
      'Client result must record its Chromium version'
    );
  }
  return result;
}

async function main(argv: readonly string[] = process.argv.slice(2)) {
  await mkdir('/tmp/georoids-benchmarks', { recursive: true });
  const directory = await mkdtemp('/tmp/georoids-benchmarks/run-');
  const interruption = new AbortController();
  const interrupt = (signal: NodeJS.Signals) =>
    interruption.abort(new Error(`Benchmark interrupted by ${signal}`));
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const command = commands(directory, interruption.signal);
  process.stdout.write(`Benchmark artifacts: ${directory}\n`);
  const failures: unknown[] = [];
  try {
    const options = parseArguments(argv);
    const harness = await harnessState(command);
    await writeJson(join(directory, 'invocation.json'), {
      startedAt: new Date().toISOString(),
      argv: process.argv,
      requestedArgs: argv,
      cwd: ROOT,
      options,
      harness,
      environment: {
        node: process.version,
        npm: (await command('npm', ['--version'])).stdout.trim(),
        os: platform(),
        release: release(),
        arch: process.arch,
        hostname: hostname(),
        cpus: cpus(),
        totalMemory: totalmem(),
      },
      excludedGeneratedRoots: [...GENERATED],
      harnessPaths: HARNESS_PATHS,
    });
    const runtimes: Awaited<ReturnType<typeof prepareRuntime>>[] = [];
    try {
      await command(
        'git',
        [
          'archive',
          '--format=tar',
          `--output=${directory}/harness.tar`,
          harness.commit,
          '--',
          ...HARNESS_PATHS,
        ],
        ROOT,
        120_000
      );
      const canLink = await verifyDependencies(command, directory);
      const baseline = await prepareRuntime({
        directory,
        label: 'baseline',
        harness,
        command,
        canLink,
        product: await revision(
          options.command.mode === 'measure' ? options.command.revision : options.command.baseline,
          command
        ),
      });
      runtimes.push(baseline);
      const candidate =
        options.command.mode === 'compare'
          ? await prepareRuntime({
              directory,
              label: 'candidate',
              harness,
              command,
              canLink,
              product: await revision(options.command.candidate, command),
            })
          : baseline;
      if (candidate !== baseline) {
        runtimes.push(candidate);
      }
      await writeJson(join(directory, 'runtimes.json'), { baseline, candidate });
      const sample = (runtime: typeof baseline, id: string) =>
        measure(runtime, id, options, directory, command);
      let result: object;
      if (options.command.mode === 'measure') {
        result = await sample(baseline, 'measure');
      } else {
        const calibration: MeasurementPair[] = [];
        const pairs: MeasurementPair[] = [];
        for (let i = 0; i < 3; i++) {
          calibration.push({
            a: await sample(baseline, `calibration-${i}-a`),
            b: await sample(baseline, `calibration-${i}-b`),
          });
        }
        for (let i = 0; i < 12; i++) {
          if (i % 2 === 0) {
            pairs.push({
              a: await sample(baseline, `pair-${i}-a`),
              b: await sample(candidate, `pair-${i}-b`),
            });
          } else {
            const b = await sample(candidate, `pair-${i}-b`);
            pairs.push({ a: await sample(baseline, `pair-${i}-a`), b });
          }
        }
        result = compareMeasurements(calibration, pairs, options.seed);
      }
      await writeJson(join(directory, 'measurement.json'), result);
    } catch (error) {
      failures.push(error);
    }
    for (const runtime of runtimes) {
      try {
        const after = await sourceHash(runtime.path);
        await writeJson(join(directory, `${runtime.label}.source-hash.json`), {
          before: runtime.sourceHash,
          after,
        });
        assert.equal(
          after,
          runtime.sourceHash,
          `${runtime.label} source changed during measurement`
        );
        const dependenciesAfter = await sourceHash(join(runtime.path, 'node_modules'), new Set());
        await writeJson(join(directory, `${runtime.label}.dependencies-hash.json`), {
          before: runtime.dependenciesHash,
          after: dependenciesAfter,
        });
        assert.equal(
          dependenciesAfter,
          runtime.dependenciesHash,
          `${runtime.label} dependencies changed during measurement`
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const finish = await harnessState(command);
      await writeJson(join(directory, 'finish.json'), finish);
      assert.equal(
        canonicalJson(finish),
        canonicalJson(harness),
        'Harness changed during measurement'
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Benchmark failed');
    }
    interruption.signal.throwIfAborted();
    await writeJson(join(directory, 'report.json'), {
      status: 'complete',
      finishedAt: new Date().toISOString(),
      measurement: 'measurement.json',
      invocation: 'invocation.json',
      runtimes: 'runtimes.json',
    });
  } catch (error) {
    try {
      await writeJson(join(directory, 'failure.json'), {
        status: 'failed',
        argv,
        error: errorRecord(error),
      });
    } catch (artifactError) {
      throw new AggregateError(
        [error, artifactError],
        'Benchmark and failure artifact write failed'
      );
    }
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
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
