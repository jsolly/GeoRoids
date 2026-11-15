import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { createRailwayContext, project } from 'railway/iac';
import definition from '../.railway/railway.ts';
import { runOwnershipPlan } from './railway-ownership-plan.ts';
import {
  railwayCli,
  railwayCliEnvironment,
  railwayTarget,
  VersionPinError,
} from './railway-version-pin.ts';

const execute = promisify(execFile);
let privateDirectory: string | undefined;
try {
  process.umask(0o077);
  if (
    process.argv.length !== 2 ||
    process.env['GITHUB_ACTIONS'] !== 'true' ||
    process.env['GITHUB_REPOSITORY'] !== 'jsolly/GeoRoids' ||
    process.env['GITHUB_REF'] !== 'refs/heads/main' ||
    process.env['GITHUB_EVENT_NAME'] !== 'workflow_dispatch'
  ) {
    throw new VersionPinError(
      'Ownership planning requires the manual trusted main workflow and no arguments'
    );
  }
  if (!process.env['RAILWAY_CONFIG_TOKEN']) {
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
      throw new VersionPinError('Ownership source must be the clean current merged main checkout');
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
    throw new VersionPinError('Reviewed production definition must retain its RAILPACK/V3 pin');
  }
  privateDirectory = await mkdtemp(join(tmpdir(), 'georoids-railway-ownership-'));
  const planPath = join(privateDirectory, 'plan.json');
  const environment = railwayCliEnvironment(process.env, cli);
  const receipt = await runOwnershipPlan({
    railway: async (args) => {
      try {
        return (
          await execute(cli, args, {
            env: environment,
            timeout: 180000,
            maxBuffer: 16 * 1024 * 1024,
          })
        ).stdout;
      } catch (error) {
        throw new VersionPinError('Read-only Railway command failed; plan inventory unverified', {
          cause: error,
        });
      }
    },
    planPath,
    readPlan: () => readFile(planPath, 'utf8'),
    sourceTree,
    desiredVersion: service.build.railpackVersion,
    assertSource,
    reportOwners: (ownership) => {
      process.stdout.write(
        `${JSON.stringify({ outcome: 'owners-observed', planVerified: false, ownership })}\n`
      );
    },
  });
  const summary = JSON.stringify(receipt);
  process.stdout.write(`${summary}\n`);
  if (process.env['GITHUB_STEP_SUMMARY']) {
    await appendFile(
      process.env['GITHUB_STEP_SUMMARY'],
      `Railway ownership-plan result: ${summary}\n`
    );
  }
  if (
    !receipt.claimConsistent ||
    receipt.foreignOwner ||
    receipt.destructive ||
    receipt.diagnosticCount !== 0 ||
    receipt.settings.status !== 'pin-only'
  ) {
    throw new VersionPinError('Complete ownership inventory found blocking policy differences');
  }
} catch (error) {
  const reason =
    error instanceof VersionPinError ? error.message : 'Unexpected ownership runner failure';
  process.stderr.write(
    `Railway ownership planning failed. ${reason}. Raw provider output was withheld.\n`
  );
  process.exitCode = 1;
} finally {
  if (privateDirectory) {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
