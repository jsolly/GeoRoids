import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const focusedPath =
  'tests/integration/browser/sanity/title-music-bed-loops-and-yields-to-playfield.test.ts';

export function parseOptions(args) {
  const options = { sha: '', output: '', focused: 20, full: 3 };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    switch (key) {
      case '--sha':
        options.sha = value;
        break;
      case '--output':
        options.output = resolve(value);
        break;
      case '--focused':
      case '--full': {
        if (!/^\d+$/u.test(value)) {
          throw new Error(`Invalid count for ${key}`);
        }
        const count = Number(value);
        const maximum = key === '--focused' ? 20 : 3;
        if (count > maximum) {
          throw new Error(`${key} exceeds the approved sample of ${maximum}`);
        }
        if (key === '--focused') {
          options.focused = count;
        } else {
          options.full = count;
        }
        break;
      }
      default:
        throw new Error(`Unknown option ${key}`);
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(options.sha)) {
    throw new Error('--sha requires a full lowercase commit SHA');
  }
  if (!options.output) {
    throw new Error('--output requires a fresh artifact directory');
  }
  if (options.focused + options.full === 0) {
    throw new Error('At least one attempt is required');
  }
  return options;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function machineSnapshot() {
  return { at: new Date().toISOString(), load: loadavg(), freeMemory: freemem() };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A nonzero runner result is retained, never retried or replaced by a later pass. */
export async function runAttempt({
  directory,
  command,
  args,
  cwd,
  env,
  consoleOutput = { stdout: process.stdout, stderr: process.stderr },
}) {
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const output = join(directory, 'output.log');
  writeFileSync(output, '');
  for (const name of ['stdout.log', 'stderr.log']) {
    writeFileSync(join(directory, name), '');
  }
  const outputErrors = [];
  const failedSinks = new Set();
  const pendingConsoleWrites = new Set();
  const result = await new Promise((fulfill) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stopRequested = false;
    const failSink = (sink, error) => {
      if (!failedSinks.has(sink)) {
        failedSinks.add(sink);
        outputErrors.push({ sink, message: String(error) });
      }
      if (!stopRequested && child.exitCode === null && child.signalCode === null) {
        stopRequested = true;
        // The repository runner handles TERM through EXIT cleanup and releases its lock.
        // Signal the owned runner only; await its closure instead of killing its process group.
        try {
          if (!child.kill('SIGTERM')) {
            outputErrors.push({ sink: 'runner-stop', message: 'TERM could not be delivered' });
          }
        } catch (stopError) {
          outputErrors.push({ sink: 'runner-stop', message: String(stopError) });
        }
      }
    };
    const consoleListeners = [];
    for (const name of ['stdout', 'stderr']) {
      const sink = consoleOutput[name];
      const onError = (error) => failSink(`console-${name}`, error);
      sink.on('error', onError);
      consoleListeners.push({ sink, onError });
      child[name].on('error', (error) => failSink(`runner-${name}`, error));
      child[name].on('data', (chunk) => {
        for (const [label, path] of [
          ['combined', output],
          [name, join(directory, `${name}.log`)],
        ]) {
          if (!failedSinks.has(label)) {
            try {
              appendFileSync(path, chunk);
            } catch (error) {
              failSink(label, error);
            }
          }
        }
        if (!failedSinks.has(`console-${name}`)) {
          let complete;
          const pending = new Promise((resolveWrite) => {
            complete = resolveWrite;
          });
          pendingConsoleWrites.add(pending);
          const settled = (error) => {
            if (error) {
              failSink(`console-${name}`, error);
            }
            pendingConsoleWrites.delete(pending);
            complete();
          };
          try {
            sink.write(chunk, settled);
          } catch (error) {
            settled(error);
          }
        }
      });
    }
    let launchError = null;
    child.on('error', (error) => {
      launchError = error.message;
    });
    child.on('close', async (code, signal) => {
      await Promise.all(pendingConsoleWrites);
      // Writable error events can follow their write callback on the next tick.
      await new Promise((resolveTick) => setImmediate(resolveTick));
      for (const { sink, onError } of consoleListeners) {
        sink.removeListener('error', onError);
      }
      fulfill({ code, signal, launchError, pid: child.pid ?? null, stopRequested });
    });
  });
  const receipt = {
    startedAt,
    durationMs: performance.now() - started,
    command,
    args,
    ...result,
    outputErrors,
    receiptWriteError: null,
  };
  try {
    writeJson(join(directory, 'runner.json'), receipt);
  } catch (error) {
    receipt.receiptWriteError = String(error);
  }
  return receipt;
}

function writeProgress(message) {
  return new Promise((fulfill) => {
    let failure = null;
    const onError = (error) => {
      failure ??= String(error);
    };
    process.stdout.on('error', onError);
    const finish = (error) => {
      if (error) {
        onError(error);
      }
      setImmediate(() => {
        process.stdout.removeListener('error', onError);
        fulfill(failure);
      });
    };
    try {
      process.stdout.write(message, finish);
    } catch (error) {
      finish(error);
    }
  });
}

export function samplePassed({ focused, full, attempts, stageFailures }) {
  return (
    stageFailures.length === 0 &&
    attempts.length === focused + full &&
    attempts.every(
      (attempt) =>
        attempt.code === 0 &&
        attempt.signal === null &&
        attempt.launchError === null &&
        attempt.artifactError === null &&
        attempt.evidenceError === null &&
        attempt.outputErrors?.length === 0 &&
        attempt.receiptWriteError === null
    )
  );
}

function artifactFiles(directory, base = directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return artifactFiles(path, base);
    }
    if (!entry.isFile()) {
      throw new Error(`Unexpected artifact type ${path}`);
    }
    return [
      {
        path,
        relative: path.slice(base.length + 1),
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      },
    ];
  });
}

export function retainArtifacts({ source, destination, previousScreenshots }) {
  const sources = ['logs', 'tests/integration/browser/screenshots'];
  const index = [];
  for (const directory of sources) {
    const path = join(source, directory);
    if (!existsSync(path)) {
      throw new Error(`Missing artifact source ${directory}`);
    }
    const files = artifactFiles(path);
    mkdirSync(join(destination, directory), { recursive: true });
    for (const file of files) {
      const changed =
        directory === 'logs' || previousScreenshots.get(file.relative) !== file.sha256;
      index.push({ file: `${directory}/${file.relative}`, sha256: file.sha256, changed });
      if (changed) {
        const target = join(destination, directory, file.relative);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(file.path, target);
      }
    }
  }
  writeJson(join(destination, 'artifact-index.json'), index);
}

export function readTestEvidence(path, expectedFiles) {
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Array.isArray(evidence.testResults) ||
    !Number.isSafeInteger(evidence.numTotalTests) ||
    evidence.numTotalTests < 1
  ) {
    throw new Error('Vitest omitted the executed scenario evidence');
  }
  if (
    evidence.success !== true ||
    evidence.numFailedTestSuites !== 0 ||
    evidence.numPendingTestSuites !== 0 ||
    evidence.numFailedTests !== 0 ||
    evidence.numPendingTests !== 0 ||
    evidence.numTodoTests !== 0 ||
    evidence.numPassedTests !== evidence.numTotalTests
  ) {
    throw new Error('Vitest reported failed, skipped, todo or incomplete tests');
  }
  const actualFiles = evidence.testResults.map((result) => resolve(result.name)).sort();
  if (
    JSON.stringify(actualFiles) !==
    JSON.stringify(expectedFiles.map((file) => resolve(root, file)).sort())
  ) {
    throw new Error('Vitest discovery differs from the pinned integration file set');
  }
  return {
    total: evidence.numTotalTests,
    passed: evidence.numPassedTests,
    files: evidence.testResults.length,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (git(['rev-parse', 'HEAD']) !== options.sha) {
    throw new Error('Checkout HEAD differs from the requested SHA');
  }
  if (git(['status', '--porcelain'])) {
    throw new Error('Checkout changes invalidate the pinned sample');
  }
  if (existsSync(options.output)) {
    throw new Error('Artifact directory already exists; previous attempts must remain intact');
  }
  mkdirSync(options.output, { recursive: true });
  const report = {
    ...options,
    status: 'incomplete',
    startedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      architecture: arch(),
      kernel: release(),
      node: process.version,
      cpu: cpus().map(({ model, speed }) => ({ model, speed })),
      totalMemory: totalmem(),
      osRelease: existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : null,
      runner: {
        image: process.env['ImageOS'] ?? null,
        imageVersion: process.env['ImageVersion'] ?? null,
        name: process.env['RUNNER_NAME'] ?? null,
      },
      lockfileSha256: createHash('sha256')
        .update(readFileSync(join(root, 'package-lock.json')))
        .digest('hex'),
      order: 'repository runner defaults; serial isolated workers; no sequence overrides',
      randomness:
        'Repository fixtures and production terrain seed are unchanged; unseeded randomness is not replaced.',
      deadlineSeconds:
        process.env['GEOROIDS_TEST_MAX_DURATION_SECONDS'] ?? '1200 (repository default)',
    },
    browsers: [],
    attempts: [],
    stageFailures: [],
  };
  const reportPath = join(options.output, 'report.json');
  const retainReport = () => writeJson(reportPath, report);
  retainReport();
  try {
    const { chromium, webkit } = await import('playwright');
    for (const browserType of [chromium, webkit]) {
      const browser = await browserType.launch({ headless: true });
      try {
        report.browsers.push({
          name: browserType.name(),
          version: browser.version(),
          executable: browserType.executablePath(),
        });
      } finally {
        await browser.close();
      }
    }
    // Record the actual source defining defaults, rather than inventing a seed override.
    report.environment.seedSources = {
      gameEngine: readFileSync(join(root, 'server/core/GameEngine.ts'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('this.worldSeed =')),
      terrain: readFileSync(join(root, 'src/physics/terrain/terrainConfig.ts'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('DEFAULT_SEED')),
    };
    retainReport();
    for (const [stage, count, path] of [
      ['focused', options.focused, focusedPath],
      ['full', options.full, 'tests/integration/'],
    ]) {
      for (let attempt = 1; attempt <= count; attempt++) {
        const directory = join(options.output, `${stage}-${String(attempt).padStart(2, '0')}`);
        const before = machineSnapshot();
        const previousScreenshots = new Map(
          artifactFiles(join(root, 'tests/integration/browser/screenshots')).map((file) => [
            file.relative,
            file.sha256,
          ])
        );
        const progressFailure = await writeProgress(
          `Starting ${stage} attempt ${attempt}/${count}\n`
        );
        if (progressFailure) {
          report.stageFailures.push({ stage: 'console-progress', message: progressFailure });
        }
        const receipt = await runAttempt({
          directory,
          command: './scripts/test-runner.sh',
          args: [
            path,
            '--reporter=verbose',
            '--reporter=json',
            `--outputFile.json=${join(directory, 'vitest.json')}`,
          ],
          cwd: root,
          env: process.env,
        });
        let evidenceError = null;
        let testEvidence = null;
        try {
          const expectedFiles =
            stage === 'focused'
              ? [focusedPath]
              : git(['ls-files', 'tests/integration/'])
                  .split('\n')
                  .filter((file) => file.endsWith('.test.ts'));
          testEvidence = readTestEvidence(join(directory, 'vitest.json'), expectedFiles);
          if (stage === 'focused' && testEvidence.total !== 6) {
            throw new Error('Focused sample must run all six browser/viewport scenarios');
          }
        } catch (error) {
          evidenceError = String(error);
        }
        let artifactError = null;
        try {
          retainArtifacts({ source: root, destination: directory, previousScreenshots });
        } catch (error) {
          artifactError = String(error);
        }
        const result = {
          stage,
          attempt,
          before,
          after: machineSnapshot(),
          ...receipt,
          artifactError,
          evidenceError,
          testEvidence,
        };
        report.attempts.push(result);
        try {
          writeJson(join(directory, 'attempt.json'), result);
        } catch (error) {
          report.stageFailures.push({ stage: 'attempt-receipt', message: String(error) });
        }
        retainReport();
      }
    }
  } catch (error) {
    report.stageFailures.push({ stage: 'setup-or-retention', message: String(error) });
  }
  const passed = samplePassed(report);
  report.status = passed ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString();
  retainReport();
  const summaryFailure = await writeProgress(
    `Repeatability ${report.status}; ${report.attempts.length}/${options.focused + options.full} attempts retained at ${options.output}\n`
  );
  if (summaryFailure) {
    report.stageFailures.push({ stage: 'console-summary', message: summaryFailure });
    report.status = 'failed';
    retainReport();
  }
  process.exitCode = passed && !summaryFailure ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
