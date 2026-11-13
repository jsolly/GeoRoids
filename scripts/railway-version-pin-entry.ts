import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createRailwayContext, project } from 'railway/iac';
import definition from '../.railway/railway.ts';
import { runNetworkSmoke } from './production-smoke-network.mjs';
import { productionUrl, smoke } from './production-smoke-scenario.mjs';
import {
  railwayCli,
  railwayTarget,
  runVersionPin,
  selectMode,
  VersionPinError,
} from './railway-version-pin.ts';

const execute = promisify(execFile);
let privateDirectory: string | undefined;
try {
  process.umask(0o077);
  const mode = selectMode({
    args: process.argv.slice(2),
    workflowMode: process.env['RAILWAY_CONFIG_MODE'],
  });
  const apply = mode === 'apply';
  if (apply && process.env['RAILWAY_CONFIG_APPLY_ENABLED'] !== 'version-pin-only') {
    throw new VersionPinError('Production apply is disabled');
  }
  if (
    process.env['GITHUB_ACTIONS'] !== 'true' ||
    process.env['GITHUB_REPOSITORY'] !== 'jsolly/GeoRoids' ||
    process.env['GITHUB_REF'] !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(process.env['GITHUB_EVENT_NAME'] ?? '')
  ) {
    throw new VersionPinError('Version-pin automation requires the trusted main workflow');
  }
  const token = process.env['RAILWAY_CONFIG_TOKEN'];
  if (!token) {
    throw new VersionPinError('Dedicated production RAILWAY_CONFIG_TOKEN is required');
  }
  if (process.env['RAILWAY_TOKEN'] || process.env['RAILWAY_API_TOKEN']) {
    throw new VersionPinError('Ambient Railway credentials are forbidden');
  }
  const cli = resolve(process.env['RAILWAY_CONFIG_CLI'] ?? '');
  if (
    !process.env['RAILWAY_CONFIG_CLI'] ||
    createHash('sha256')
      .update(await readFile(cli))
      .digest('hex') !== railwayCli.binarySha256
  ) {
    throw new VersionPinError('Railway CLI binary checksum differs from reviewed 5.50.2');
  }
  const git = async (...args: string[]) =>
    (await execute('git', args, { timeout: 30000 })).stdout.trim();
  const sourceTree = await git('rev-parse', 'HEAD:.railway');
  const assertSource = async () => {
    const head = await git('rev-parse', 'HEAD');
    const remote = (await git('ls-remote', 'origin', 'refs/heads/main')).split(/\s/u)[0];
    if (
      !/^[a-f0-9]{40}$/u.test(head) ||
      head !== process.env['GITHUB_SHA'] ||
      head !== remote ||
      (await git('status', '--porcelain')) !== '' ||
      sourceTree !== (await git('rev-parse', 'HEAD:.railway'))
    ) {
      throw new VersionPinError(
        'Version-pin source must be the clean current merged main checkout'
      );
    }
  };
  await assertSource();
  const graph = await definition(createRailwayContext(), project);
  const services = (graph.resources ?? [])
    .flat()
    .filter((resource) => resource.type === 'service' && resource.name === railwayTarget.name);
  const [service] = services;
  if (
    services.length !== 1 ||
    !service ||
    service.type !== 'service' ||
    service.build?.builder !== 'RAILPACK' ||
    service.build.buildEnvironment !== 'V3' ||
    typeof service.build.railpackVersion !== 'string'
  ) {
    throw new VersionPinError('Reviewed production service must have one RAILPACK/V3 version pin');
  }
  privateDirectory = await mkdtemp(join(tmpdir(), 'georoids-railway-config-'));
  const planPath = join(privateDirectory, 'plan.json');
  // Children receive only the dedicated token. Capture every byte; provider errors may contain secrets.
  const cliEnvironment = { ...process.env };
  for (const key of Object.keys(cliEnvironment)) {
    if (key.startsWith('RAILWAY_')) {
      delete cliEnvironment[key];
    }
  }
  Object.assign(cliEnvironment, {
    RAILWAY_TOKEN: token,
    RAILWAY_PROJECT_ID: railwayTarget.project,
    RAILWAY_ENVIRONMENT_ID: railwayTarget.environment,
    RAILWAY_SERVICE_ID: railwayTarget.service,
    RAILWAY_CALLER: 'skill:use-railway@1.3.5',
    RAILWAY_AGENT_SESSION: `georoids-version-pin-${process.env['GITHUB_RUN_ID'] ?? 'workflow'}`,
    CI: 'true',
  });
  const receipt = await runVersionPin({
    railway: async (args) => {
      try {
        return (
          await execute(cli, args, {
            env: cliEnvironment,
            timeout: 180000,
            maxBuffer: 16 * 1024 * 1024,
          })
        ).stdout;
      } catch (error) {
        throw new VersionPinError(
          'Pinned Railway command failed; raw provider output was withheld',
          {
            cause: error,
          }
        );
      }
    },
    planPath,
    readPlan: () => readFile(planPath, 'utf8'),
    sourceTree,
    desiredVersion: service.build.railpackVersion,
    apply,
    assertSource,
    sleep: () => delay(5000),
    smoke: async () => {
      const result = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env: {
          PRODUCTION_SMOKE_RELEASE_SHA: process.env['GITHUB_SHA'],
          PRODUCTION_SMOKE_REQUEST_ID: `railway-config-${process.env['GITHUB_RUN_ID'] ?? 'workflow'}`,
        },
        artifacts: join(privateDirectory ?? tmpdir(), 'smoke'),
        report: () => {},
      });
      if (!result.success) {
        throw new VersionPinError('Canonical production gameplay smoke failed');
      }
    },
  });
  const summary = JSON.stringify(receipt);
  process.stdout.write(`${summary}\n`);
  if (process.env['GITHUB_STEP_SUMMARY']) {
    await appendFile(
      process.env['GITHUB_STEP_SUMMARY'],
      `Railway version-pin result: ${summary}\n`
    );
  }
} catch (error) {
  // Only our fixed policy text is public. Never serialize provider causes or stacks.
  const reason = error instanceof VersionPinError ? error.message : 'Unexpected runner failure';
  process.stderr.write(
    `Railway version-pin verification failed. ${reason}. Raw provider output was withheld.\n`
  );
  process.exitCode = 1;
} finally {
  if (privateDirectory) {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
