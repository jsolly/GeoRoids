import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ASTEROID_INTERACTIONS_CAPABILITY, SNAPSHOT_VERSION } from '../shared/snapshotProtocol';
import { collectLiveReportMetadata } from './live-report';
import { Pilot } from './pilot';

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '120' },
    warmup: { type: 'string', default: '30' },
    output: { type: 'string' },
    profile: { type: 'boolean', default: false },
    scene: { type: 'string', default: 'natural' },
    pilots: { type: 'string', default: '10' },
    persistence: { type: 'boolean', default: false },
  },
});
const runStartedSeconds = Math.floor(Date.now() / 1000);
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
const participants = Number(values.pilots);
assert([10, 25, 50, 100].includes(participants), 'pilots must be 10, 25, 50 or 100');
assert(
  values.scene === 'endurance' || values.scene === 'natural',
  'scene must be endurance or natural'
);
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 300, 'seconds must be 1..300');
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 60, 'warmup must be 0..60');
assert(values.output, 'An explicit artifact directory is required');
const directory = resolvePath(values.output);
await mkdir(directory, { recursive: false });
const metadata = collectLiveReportMetadata();
const hardware = {
  availableParallelism: availableParallelism(),
  hostMemoryBytes: totalmem(),
  cpuQuota: existsSync('/sys/fs/cgroup/cpu.max')
    ? readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
    : null,
  memoryLimit: existsSync('/sys/fs/cgroup/memory.max')
    ? readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    : null,
};
const failures: unknown[] = [];
const failed = new AbortController();
const fail = (error: unknown) => {
  failures.push(error);
  failed.abort(error);
};
const deadline = () => AbortSignal.any([failed.signal, AbortSignal.timeout(10_000)]);
let measuring = false;
let stopping = false;
let began = false;
let ended = false;
const pilots: Pilot[] = [];
const messages: unknown[] = [];
const child = spawn(
  process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./loaded-battle-server.ts', import.meta.url))],
  {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SERVER_LOG_LEVEL: 'error',
      PORT: '0',
      GEOROIDS_WORLD_PATH: '',
      GEOROIDS_PERFORMANCE: '1',
      GEOROIDS_LOADED_PROFILE_DIRECTORY: directory,
      GEOROIDS_LOADED_SCENE: values.scene,
      GEOROIDS_LOADED_PILOTS: String(participants),
      GEOROIDS_LOADED_PERSISTENCE: values.persistence ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }
);
let stdout = '';
let stderr = '';
assert(child.stdout && child.stderr);
child.stdout.on('data', (chunk: Buffer) => {
  stdout += chunk.toString();
  assert(stdout.length < 1024 * 1024, 'Server stdout exceeded bound');
});
child.stderr.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
  assert(stderr.length < 1024 * 1024, 'Server stderr exceeded bound');
});
child.on('error', fail);
child.on('message', (message: unknown) => messages.push(message));
const exited = once(child, 'exit');
child.on('exit', (code, signal) => {
  if (!stopping || code !== 0 || signal !== null) {
    fail(new Error(`Loaded child exited: ${code}, ${signal}; ${stderr}`));
  }
});

async function waitMessage(type: string, cleanup = false) {
  const until = performance.now() + 10_000;
  for (;;) {
    for (const item of messages) {
      if (item !== null && typeof item === 'object' && 'type' in item && item.type === type) {
        return item;
      }
    }
    assert(performance.now() < until, `Missing child ${type} reply; ${stderr}`);
    await delay(10, undefined, { signal: cleanup ? AbortSignal.timeout(10_000) : deadline() });
  }
}
async function command(
  message: { type: 'arrange' | 'end' | 'shutdown' } | { type: 'begin'; profile: boolean },
  reply: string,
  cleanup = false
) {
  await new Promise<void>((resolve, reject) =>
    child.send(message, (error: Error | null) => (error ? reject(error) : resolve()))
  );
  return waitMessage(reply, cleanup);
}
async function drive(durationMs: number) {
  const start = performance.now();
  let tick = 0;
  while (performance.now() - start < durationMs) {
    for (const pilot of pilots) {
      pilot.drive(tick);
    }
    tick++;
    assert(performance.now() - start - tick * 50 < 1000, 'Driver fell over one second behind');
    await delay(Math.max(0, start + tick * 50 - performance.now()), undefined, {
      signal: failed.signal,
    });
  }
}

let fixture: unknown;
let driverCpu: NodeJS.CpuUsage | undefined;
try {
  const ready = await waitMessage('ready');
  assert('port' in ready && typeof ready.port === 'number');
  const url = new URL(
    `ws://127.0.0.1:${ready.port}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=${ASTEROID_INTERACTIONS_CAPABILITY}&explorationVersion=1`
  );
  const pilotOptions = { url, measuring: () => measuring, fail, aimAtAsteroids: true };
  for (let index = 0; index < participants; index++) {
    const pilot = new Pilot(index, pilotOptions);
    pilots.push(pilot);
    const until = performance.now() + 10_000;
    while (!pilot.state) {
      assert(performance.now() < until, `Pilot ${index} never received state`);
      await delay(10, undefined, { signal: deadline() });
    }
  }
  const epochs = pilots.map(
    (pilot) => pilot.state?.entities.find((actor) => actor.id === pilot.id)?.playerMotion?.epoch
  );
  fixture = await command({ type: 'arrange' }, 'arranged');
  assert(
    fixture !== null &&
      typeof fixture === 'object' &&
      'hash' in fixture &&
      typeof fixture.hash === 'string'
  );
  const retainedFixture = await readFile(join(directory, 'fixture.json'));
  assert.equal(
    createHash('sha256').update(retainedFixture).digest('hex'),
    fixture.hash,
    'Retained fixture hash mismatch'
  );
  // Wait for the actual new keyframes rather than driving a stale pre-arrangement pose.
  const until = performance.now() + 10_000;
  while (
    pilots.some((pilot, index) => {
      const epoch = pilot.state?.entities.find((actor) => actor.id === pilot.id)?.playerMotion
        ?.epoch;
      return epoch === undefined || epoch === epochs[index];
    })
  ) {
    assert(performance.now() < until, 'Pilots did not apply arranged motion epochs');
    await delay(10, undefined, { signal: deadline() });
  }
  await drive(warmup * 1000);
  await command({ type: 'begin', profile: values.profile }, 'begun');
  began = true;
  measuring = true;
  driverCpu = process.cpuUsage();
  const start = performance.now();
  for (const pilot of pilots) {
    pilot.beginMeasurement(start);
  }
  await drive(seconds * 1000);
  for (const pilot of pilots) {
    pilot.stopMeasurement();
  }
  measuring = false;
  driverCpu = process.cpuUsage(driverCpu);
  const end = await command({ type: 'end' }, 'ended');
  ended = true;
  assert('workload' in end && end.workload !== null && typeof end.workload === 'object');
  const workload = end.workload;
  assert(
    'playersPresent' in workload && workload.playersPresent === true,
    'Loaded fixture lost participants'
  );
  assert(
    'damageOrDestructionObserved' in workload && workload.damageOrDestructionObserved === true,
    'Loaded fixture observed no measured authoritative damage or destruction'
  );
  assert(
    'movedTowTargets' in workload && workload.movedTowTargets === 5,
    'Loaded fixture did not observe all five original tow targets move'
  );
  for (const pilot of pilots) {
    pilot.validateCompletion();
    pilot.completedScenario = true;
  }
} catch (error) {
  failures.push(error);
} finally {
  measuring = false;
  for (const pilot of pilots) {
    pilot.stopMeasurement();
  }
  if (began && !ended && child.exitCode === null) {
    try {
      await command({ type: 'end' }, 'ended', true);
    } catch (error) {
      failures.push(error);
    }
  }
  const cleanup = await Promise.allSettled(pilots.map((pilot) => pilot.close()));
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
  stopping = true;
  try {
    await command({ type: 'shutdown' }, 'closed', true);
    const result =
      child.exitCode === null
        ? await once(child, 'exit', { signal: AbortSignal.timeout(10_000) })
        : await exited;
    assert.deepEqual(result, [0, null]);
  } catch (error) {
    failures.push(error);
    child.kill('SIGKILL');
    await exited;
  }
  const after = collectLiveReportMetadata();
  if (metadata.git.sourceSha256 !== after.git.sourceSha256) {
    failures.push(new Error('Benchmark source changed during recording'));
  }
  await writeFile(join(directory, 'server.stdout.log'), stdout);
  await writeFile(join(directory, 'server.stderr.log'), stderr);
  await writeFile(
    join(directory, 'driver.json'),
    JSON.stringify(
      {
        status: failures.length ? 'failed' : 'passed',
        metadata,
        hardware,
        after,
        parameters: {
          pilots: participants,
          asteroids: 80,
          seed: 42,
          seconds,
          warmup,
          profile: values.profile,
          scene: values.scene,
          asteroidFixture:
            values.scene === 'endurance'
              ? '80 initial metal rocks at finite health100000; original reflective phenomena remain and can destroy rocks'
              : '80 initial seeded rocks with ordinary materials, health and phenomena; natural damage/destruction/fragments remain',
          inputHz: 20,
          offeredShotsHz: 2,
          persistence: values.persistence ? 'isolated file-backed worker' : 'excluded',
          admission: 'test mode bypasses connection and message budgets',
          towing:
            'five arranged tow-cable attachments; ordinary subsequent physics, no reseeding or health resets',
        },
        fixture,
        driverCpu,
        pilots: pilots.map((pilot) => pilot.report()),
        failures: failures.map(String),
        cleanup: child.exitCode === 0 && cleanup.every((result) => result.status === 'fulfilled'),
      },
      null,
      2
    )
  );
  execFileSync(
    process.execPath,
    [
      'scripts/review-receipt.mjs',
      'runner',
      directory,
      process.env['GEOROIDS_TEST_RUNNER_RECEIPT'] ?? '',
      'benchmark-loaded',
      fileURLToPath(new URL('../', import.meta.url)),
      String(process.pid),
      String(runStartedSeconds),
      failures.length ? '1' : '0',
      child.exitCode === 0 && cleanup.every((result) => result.status === 'fulfilled')
        ? 'true'
        : 'false',
      'false',
      'false',
      '',
      '',
    ],
    { timeout: 10_000, stdio: 'inherit' }
  );
}
if (failures.length) {
  throw new AggregateError(failures, `Loaded battle failed; artifacts: ${directory}`);
}
process.stdout.write(`Loaded battle complete: ${directory}\n`);
