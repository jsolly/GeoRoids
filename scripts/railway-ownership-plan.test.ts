import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parse } from 'yaml';
import {
  inspectOwnershipPlan,
  readOwnershipSnapshot,
  runOwnershipPlan,
} from './railway-ownership-plan.ts';
import { railwayCli, railwayTarget, reviewPlan, stableJson } from './railway-version-pin.ts';

const tree = 'd0a934bd14a4529689009aca626bba12a61db775d';
const volumeId = 'a32aab03-3044-46a5-ba40-578f8c6d2129';
const secret = 'PRIVATE-REPORT-TOKEN-NEVER-PRINT';
const beforeBuild = { builder: 'RAILPACK', buildEnvironment: 'V3' };
const afterBuild = { ...beforeBuild, railpackVersion: '0.43.0' };
const addresses = ['volume.world-data', 'service.Georoids'];

// External fixtures follow pinned engine.rs::EnvNode/parse_owners and partial.rs,
// saved_plan.rs and change_set.rs. They do not prove a live provider contract.
function snapshot() {
  const iacPartials: unknown = null;
  return {
    data: {
      environment: {
        id: '94d3de2f-4bb0-4051-8975-a30190c2fffa',
        projectId: railwayTarget.project,
        configEtag: 'etag-before',
        iacPartials,
        config: {
          services: {
            [railwayTarget.service]: {
              build: { ...beforeBuild },
              variables: { TODOIST_API_TOKEN: { value: secret } },
              volumeMounts: { [volumeId]: { mountPath: '/data' } },
            },
          },
          volumes: { [volumeId]: { region: 'iad', sizeMB: 1024 } },
        },
      },
      project: {
        id: railwayTarget.project,
        services: {
          edges: [{ node: { id: '4e2cb2a2-c1e2-41a8-a970-3f60659c2524', name: 'Georoids' } }],
          pageInfo: { hasNextPage: false },
        },
        volumes: {
          edges: [{ node: { id: volumeId, name: 'world-data' } }],
          pageInfo: { hasNextPage: false },
        },
      },
      environmentStagedChanges: { id: 'draft', status: 'STAGED', patch: {} },
      serviceInstance: { latestDeployment: { id: 'existing-deployment', status: 'SUCCESS' } },
    },
  };
}
function change() {
  return {
    kind: 'resource.update',
    address: 'service.Georoids',
    field: 'build',
    before: beforeBuild,
    after: afterBuild,
    path: 'resources.service.Georoids.build',
    summary: 'Update Georoids build.railpackVersion',
    severity: 'safe',
    deployEffect: 'deploy',
    details: ['build.railpackVersion (null → "0.43.0")'],
  };
}
function rehash<T extends { changeSet: unknown; changeSetHash: string }>(value: T): T {
  value.changeSetHash = `sha256:${createHash('sha256').update(stableJson(value.changeSet)).digest('hex')}`;
  return value;
}
function plan(changes: unknown[] = [change()]) {
  const diagnostics: unknown[] = [];
  return rehash({
    kind: 'railway.config.plan',
    version: 1,
    cliVersion: '5.50.2',
    sourceTree: tree,
    environmentId: railwayTarget.environment,
    configEtag: 'etag-before',
    destructive: false,
    claim: true,
    changeSetHash: '',
    diff: secret,
    changeSet: {
      version: 1,
      changes,
      diagnostics,
      declared: addresses,
      telemetry: { language: 'typescript' },
    },
  });
}
function inspect(value = plan(), current = snapshot()) {
  return inspectOwnershipPlan(value, {
    sourceTree: tree,
    version: '0.43.0',
    snapshot: readOwnershipSnapshot(current),
  });
}

test('explicit null and empty owner maps identify each first claim, while missing metadata blocks', () => {
  const current = snapshot();
  const owners = readOwnershipSnapshot(current).ownership;
  assert.deepEqual(owners, [
    {
      address: 'volume.world-data',
      resourceId: volumeId,
      currentOwner: null,
      intendedOwner: '*',
      claimNeeded: true,
    },
    {
      address: 'service.Georoids',
      resourceId: railwayTarget.service,
      currentOwner: null,
      intendedOwner: '*',
      claimNeeded: true,
    },
  ]);
  current.data.environment.iacPartials = {};
  assert.deepEqual(readOwnershipSnapshot(current).ownership, owners);
  const { iacPartials: _removed, ...missing } = current.data.environment;
  assert.throws(
    () => readOwnershipSnapshot({ data: { ...current.data, environment: missing } }),
    /map is missing/u
  );
});

test('partial claims and foreign named owners are reported without treating them as apply permission', () => {
  const current = snapshot();
  current.data.environment.iacPartials = {
    'volume.world-data': '*',
    'service.Georoids': 'other-repo',
  };
  const result = inspect(plan(), current);
  assert.deepEqual(
    result.ownership.map((row) => [row.currentOwner, row.claimNeeded]),
    [
      ['*', false],
      ['other-repo', true],
    ]
  );
  assert.equal(result.foreignOwner, true);
  assert.equal(result.liveApprovalReady, false);
  assert.equal(result.pinPolicyAccepted, false);
  current.data.environment.iacPartials = { 'volume.world-data': '*', 'service.Georoids': '*' };
  const artifact = plan();
  assert.equal(inspect(artifact, current).claimConsistent, false);
  artifact.claim = false;
  assert.equal(inspect(artifact, current).pinPolicyAccepted, true);
});

test('malformed, out-of-scope and unavailable ownership never become an empty map', () => {
  for (const owners of [
    [],
    'missing',
    { 'service.Georoids': null },
    { 'service.Georoids': '' },
    { 'service.Georoids': 'bad owner' },
    { [secret]: '*' },
  ]) {
    const current = snapshot();
    current.data.environment.iacPartials = owners;
    assert.throws(() => readOwnershipSnapshot(current));
  }
  assert.throws(
    () => readOwnershipSnapshot({ errors: [{ message: secret }] }),
    /owner map unavailable/u
  );
});

test('mapping, volume, mount, pagination and staged-work drift block exact production inspection', () => {
  const mutations: Array<(current: ReturnType<typeof snapshot>) => void> = [
    (current) => {
      current.data.environment.id = 'wrong-environment';
    },
    (current) => {
      current.data.project.services.edges.push({ node: { id: 'different', name: 'Georoids' } });
    },
    (current) => {
      current.data.project.volumes.edges = [{ node: { id: 'different', name: 'world-data' } }];
    },
    (current) => {
      current.data.project.volumes.pageInfo.hasNextPage = true;
    },
    (current) => {
      current.data.environment.config.volumes[volumeId].sizeMB = 2048;
    },
    (current) => {
      current.data.environment.config.services[railwayTarget.service].volumeMounts[
        volumeId
      ].mountPath = '/other';
    },
    (current) => {
      current.data.environmentStagedChanges.status = 'APPLYING';
    },
  ];
  for (const mutate of mutations) {
    const current = snapshot();
    mutate(current);
    assert.throws(() => readOwnershipSnapshot(current));
  }
});

test('ownership inspection checks the complete pin despite claim=true, while original admission stays closed', () => {
  const artifact = plan();
  const result = inspect(artifact);
  assert.equal(result.settings.status, 'pin-only');
  assert.deepEqual(result.operations, [
    {
      index: 0,
      kind: 'resource.update',
      address: 'service.Georoids',
      field: 'build',
      unknownFieldCount: 0,
      values: 'withheld',
    },
  ]);
  assert.equal(result.operationCount, 1);
  assert.equal(result.claimConsistent, true);
  assert.equal(result.pinPolicyAccepted, false);
  assert.throws(
    () =>
      reviewPlan(artifact, {
        sourceTree: tree,
        version: '0.43.0',
        snapshot: readOwnershipSnapshot(snapshot()).pin,
      }),
    /ownership-claim/u
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('every unexpected operation is inventoried in order without arbitrary fields, summaries or secret values', () => {
  const artifact = plan([
    {
      ...change(),
      field: 'variables',
      before: { TODOIST_API_TOKEN: secret },
      after: { TODOIST_API_TOKEN: 'replacement' },
      summary: secret,
    },
    { kind: secret, address: secret, field: secret, [secret]: secret },
    null,
  ]);
  artifact.destructive = true;
  artifact.changeSet.diagnostics = [{ message: secret }];
  rehash(artifact);
  const result = inspect(artifact);
  assert.equal(result.operationCount, 3);
  assert.deepEqual(
    result.operations.map((row) => row.index),
    [0, 1, 2]
  );
  assert.deepEqual(
    result.operations.map((row) => row.field),
    ['variables', 'unrecognized', 'unrecognized']
  );
  assert.equal(result.operations[1]?.unknownFieldCount, 1);
  assert.equal(result.settings.status, 'outside-pin-policy');
  assert.equal(result.destructive, true);
  assert.equal(result.diagnosticCount, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('bad identity/hash/schema/declarations and oversized plans explicitly leave inventory unverified', () => {
  const variants = [
    { ...plan(), sourceTree: 'other' },
    { ...plan(), changeSetHash: secret },
    { ...plan(), cliVersion: '5.74.0' },
    { ...plan(), [secret]: secret },
    rehash({ ...plan(), changeSet: { ...plan().changeSet, declared: ['service.Other'] } }),
    plan(Array.from({ length: 257 }, change)),
  ];
  for (const artifact of variants) {
    assert.throws(
      () =>
        inspectOwnershipPlan(artifact, {
          sourceTree: tree,
          version: '0.43.0',
          snapshot: readOwnershipSnapshot(snapshot()),
        }),
      /inventory unverified/u
    );
  }
});

function provider(artifact = plan()) {
  const calls: string[][] = [];
  let snapshots = 0;
  let reads = 0;
  let sourceChecks = 0;
  const observed: unknown[] = [];
  const options = {
    railway: (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api') {
        snapshots++;
        return Promise.resolve(JSON.stringify(snapshot()));
      }
      assert.deepEqual(args, ['config', 'plan', '--json', '--out', '/private/plan.json']);
      return Promise.resolve('');
    },
    planPath: '/private/plan.json',
    readPlan: () => {
      reads++;
      return Promise.resolve(JSON.stringify(artifact));
    },
    sourceTree: tree,
    desiredVersion: '0.43.0',
    assertSource: () => {
      sourceChecks++;
      return Promise.resolve();
    },
    reportOwners: (owners: unknown) => {
      observed.push(owners);
    },
  };
  return { calls, options, observed, counts: () => ({ snapshots, reads, sourceChecks }) };
}

test('read-only orchestration proves stability for a complete policy-blocked inventory and never applies', async () => {
  const current = provider(plan([change(), { ...change(), field: 'deploy' }]));
  const result = await runOwnershipPlan(current.options);
  assert.equal(result.settings.status, 'outside-pin-policy');
  assert.equal(result.stabilityVerified, true);
  assert.equal(result.operationCount, 2);
  assert.equal(result.applicationEnabled, false);
  assert.equal(result.deploymentId, null);
  assert.equal(current.observed.length, 1);
  assert.deepEqual(current.counts(), { snapshots: 2, reads: 2, sourceChecks: 2 });
  assert.deepEqual(
    current.calls.map((args) => args[0]),
    ['api', 'config', 'api']
  );
  const query = current.calls[0]?.[1];
  assert.ok(query);
  assert.match(query, /iacPartials/u);
  assert.match(query, /decryptVariables: false/u);
  assert.doesNotMatch(query, /mutation/u);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('owner/config/etag/source/saved-byte changes refuse stability, including changes under an unchanged etag', async () => {
  for (const kind of ['owner', 'config', 'etag', 'source', 'saved']) {
    const current = provider();
    let queryCount = 0;
    const original = current.options.railway;
    current.options.railway = async (args) => {
      const raw = await original(args);
      if (args[0] !== 'api' || ++queryCount !== 2) {
        return raw;
      }
      const next = snapshot();
      if (kind === 'owner') {
        next.data.environment.iacPartials = { 'service.Georoids': '*' };
      }
      if (kind === 'config') {
        next.data.environment.config.services[
          railwayTarget.service
        ].variables.TODOIST_API_TOKEN.value = 'changed';
      }
      if (kind === 'etag') {
        next.data.environment.configEtag = 'changed';
      }
      return JSON.stringify(next);
    };
    if (kind === 'source') {
      let checks = 0;
      current.options.assertSource = () => {
        if (++checks === 2) {
          return Promise.reject(new Error('changed source'));
        }
        return Promise.resolve();
      };
    }
    if (kind === 'saved') {
      let reads = 0;
      current.options.readPlan = () =>
        Promise.resolve(`${JSON.stringify(plan())}${++reads === 2 ? '\n' : ''}`);
    }
    await assert.rejects(runOwnershipPlan(current.options));
    assert.equal(
      current.calls.some((args) => args[1] === 'apply'),
      false
    );
  }
});

test('a native plan failure leaves observed owners explicitly separate from any verified plan', async () => {
  const current = provider();
  const original = current.options.railway;
  current.options.railway = (args) => {
    if (args[0] === 'config') {
      return Promise.reject(new Error('provider failed'));
    }
    return original(args);
  };
  await assert.rejects(runOwnershipPlan(current.options), /provider failed/u);
  assert.equal(current.observed.length, 1);
  assert.deepEqual(current.counts(), { snapshots: 1, reads: 0, sourceChecks: 1 });
});

test('manual ownership workflow has no inputs, automatic events or application command', () => {
  const workflow = parse(
    readFileSync(
      new URL('../.github/workflows/railway-ownership-plan.yml', import.meta.url),
      'utf8'
    )
  );
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, {
    group: 'railway-production-version-pin',
    'cancel-in-progress': false,
  });
  const job = workflow.jobs.inspect;
  assert.equal(job.environment, 'railway-production-config');
  assert.equal(
    job.if,
    "github.repository == 'jsolly/GeoRoids' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'"
  );
  const secretSteps = job.steps.filter(
    (step: { env?: Record<string, string> }) => step.env?.['RAILWAY_CONFIG_TOKEN']
  );
  assert.equal(secretSteps.length, 1);
  assert.match(
    secretSteps[0].env.RAILWAY_CONFIG_TOKEN,
    /^\$\{\{ secrets.RAILWAY_CONFIG_TOKEN \}\}$/u
  );
  assert.deepEqual(
    Object.keys(secretSteps[0].env).sort((left, right) => left.localeCompare(right)),
    ['RAILWAY_CONFIG_APPLY_ENABLED', 'RAILWAY_CONFIG_TOKEN']
  );
  assert.deepEqual(
    { RAILWAY_CONFIG_APPLY_ENABLED: secretSteps[0].env.RAILWAY_CONFIG_APPLY_ENABLED },
    {
      RAILWAY_CONFIG_APPLY_ENABLED: 'disabled',
    }
  );
  assert.equal(
    secretSteps[0].run,
    'umask 077\nnode --import tsx scripts/railway-ownership-plan-entry.ts\n'
  );
  for (const step of job.steps) {
    if (step.uses) {
      assert.match(step.uses, /@[a-f0-9]{40}$/u);
    }
    assert.equal(step.uses?.startsWith('actions/upload-artifact@') ?? false, false);
  }
  const install = job.steps.find(
    (step: { name: string }) => step.name === 'Install checksum-pinned official Railway CLI'
  );
  assert.ok(
    install.run.includes(
      `/v${railwayCli.version}/railway-v${railwayCli.version}-x86_64-unknown-linux-musl.tar.gz`
    )
  );
  assert.ok(install.run.includes(railwayCli.archiveSha256));
  assert.ok(install.run.includes(railwayCli.binarySha256));
});

test('entry rejects apply arguments and nonmanual events before credentials or provider access', () => {
  const attempts: Array<{ args: string[]; event: string }> = [
    { args: ['--apply'], event: 'workflow_dispatch' },
    { args: [], event: 'push' },
  ];
  for (const { args, event } of attempts) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/railway-ownership-plan-entry.ts', ...args],
      {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'jsolly/GeoRoids',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_EVENT_NAME: event,
          RAILWAY_CONFIG_TOKEN: secret,
          RAILWAY_CONFIG_APPLY_ENABLED: 'version-pin-only',
          RAILWAY_CONFIG_CLI: secret,
        },
      }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manual trusted main workflow and no arguments/u);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
});

function entryFixture(artifact: ReturnType<typeof plan>, current = snapshot(), failPlan = false) {
  const root = mkdtempSync(join(tmpdir(), 'ownership-entry-'));
  const bin = join(root, 'bin');
  const privateFiles = join(root, 'private');
  mkdirSync(bin);
  mkdirSync(privateFiles);
  for (const relative of [
    'scripts/railway-ownership-plan-entry.ts',
    'scripts/railway-ownership-plan.ts',
    'scripts/railway-version-pin.ts',
    '.railway/railway.ts',
  ]) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(`../${relative}`, import.meta.url), destination);
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  symlinkSync(
    fileURLToPath(new URL('../node_modules/', import.meta.url)),
    join(root, 'node_modules'),
    'dir'
  );
  const dataPath = join(root, 'provider.json');
  const callsPath = join(root, 'calls.jsonl');
  const gitCallsPath = join(root, 'git.jsonl');
  const summaryPath = join(root, 'summary.md');
  const head = 'aa11111111111111111111111111111111111111';
  writeFileSync(
    dataPath,
    JSON.stringify({ snapshot: current, artifact, failPlan, head, tree, secret })
  );
  const cli = join(bin, 'railway');
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(process.env.OWNERSHIP_FIXTURE_DATA, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OWNERSHIP_FIXTURE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  process.stdout.write(JSON.stringify(data.snapshot));
} else if (args[0] === 'config' && args[1] === 'plan' && args[2] === '--json' && args[3] === '--out' && args.length === 5) {
  if (data.failPlan) {
    process.stdout.write(data.secret);
    process.stderr.write(data.secret);
    process.exit(1);
  }
  fs.writeFileSync(args[4], JSON.stringify(data.artifact));
} else {
  process.exit(77);
}
`,
    { mode: 0o700 }
  );
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(process.env.OWNERSHIP_FIXTURE_DATA, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OWNERSHIP_FIXTURE_GIT_CALLS, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD:.railway'])) process.stdout.write(data.tree + '\\n');
else if (JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])) process.stdout.write(data.head + '\\n');
else if (JSON.stringify(args) === JSON.stringify(['ls-remote', 'origin', 'refs/heads/main'])) process.stdout.write(data.head + '\\trefs/heads/main\\n');
else if (JSON.stringify(args) !== JSON.stringify(['status', '--porcelain'])) process.exit(78);
`,
    { mode: 0o700 }
  );
  // Only this isolated copy trusts the synthetic executable. Production pins stay unchanged.
  const policyPath = join(root, 'scripts/railway-version-pin.ts');
  const policy = readFileSync(policyPath, 'utf8');
  assert.equal(policy.split(railwayCli.binarySha256).length, 2);
  writeFileSync(
    policyPath,
    policy.replace(
      railwayCli.binarySha256,
      createHash('sha256').update(readFileSync(cli)).digest('hex')
    )
  );
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) {
      delete environment[key];
    }
  }
  return {
    root,
    privateFiles,
    callsPath,
    gitCallsPath,
    summaryPath,
    run: () =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/railway-ownership-plan-entry.ts'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...environment,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          TMPDIR: privateFiles,
          TSX_DISABLE_CACHE: '1',
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'jsolly/GeoRoids',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_SHA: head,
          GITHUB_STEP_SUMMARY: summaryPath,
          RAILWAY_CONFIG_TOKEN: secret,
          RAILWAY_TOKEN: '',
          RAILWAY_API_TOKEN: '',
          RAILWAY_CONFIG_CLI: cli,
          OWNERSHIP_FIXTURE_DATA: dataPath,
          OWNERSHIP_FIXTURE_CALLS: callsPath,
          OWNERSHIP_FIXTURE_GIT_CALLS: gitCallsPath,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }),
  };
}

test('executed entry succeeds for first ownership inspection and preserves private-file cleanup', () => {
  const fixture = entryFixture(plan());
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].outcome, 'owners-observed');
    assert.equal(lines[0].planVerified, false);
    assert.equal(lines[1].outcome, 'ownership-plan-only');
    assert.equal(lines[1].claim, true);
    assert.equal(lines[1].pinPolicyAccepted, false);
    assert.equal(lines[1].settings.status, 'pin-only');
    assert.equal(lines[1].stabilityVerified, true);
    assert.equal(lines[1].applicationEnabled, false);
    assert.equal(lines[1].liveApprovalReady, false);
    assert.equal(lines[1].operationCount, 1);
    assert.deepEqual(readdirSync(fixture.privateFiles), []);
    assert.equal(
      `${result.stdout}${result.stderr}${readFileSync(fixture.summaryPath, 'utf8')}`.includes(
        secret
      ),
      false
    );
    const calls = readFileSync(fixture.callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['api', 'config', 'api']
    );
    const gitCalls = readFileSync(fixture.gitCallsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(gitCalls.filter((args) => args[0] === 'ls-remote').length, 3);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executed entry emits the complete sanitized inventory and fails for every terminal blocker', () => {
  for (const kind of [
    'foreign-owner',
    'inconsistent-claim',
    'destructive',
    'diagnostics',
    'settings',
  ]) {
    const artifact = plan();
    const current = snapshot();
    if (kind === 'foreign-owner') {
      current.data.environment.iacPartials = { 'service.Georoids': 'other-repo' };
    }
    if (kind === 'inconsistent-claim') {
      artifact.claim = false;
    }
    if (kind === 'destructive') {
      artifact.destructive = true;
    }
    if (kind === 'diagnostics') {
      artifact.changeSet.diagnostics.push({ message: secret });
    }
    if (kind === 'settings') {
      artifact.changeSet.changes.push({ ...change(), field: 'deploy' });
    }
    rehash(artifact);
    const fixture = entryFixture(artifact, current);
    try {
      const result = fixture.run();
      assert.equal(result.status, 1, `${kind}: ${result.stderr}`);
      const lines = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].outcome, 'owners-observed');
      assert.equal(lines[1].outcome, 'ownership-plan-only');
      assert.equal(lines[1].operationCount, artifact.changeSet.changes.length);
      assert.equal(lines[1].operations.length, artifact.changeSet.changes.length);
      assert.equal(lines[1].stabilityVerified, true);
      assert.equal(lines[1].pinPolicyAccepted, false);
      assert.match(
        result.stderr,
        /Complete ownership inventory found blocking policy differences/u
      );
      const summary = readFileSync(fixture.summaryPath, 'utf8');
      assert.ok(summary.includes(JSON.stringify(lines[1])));
      assert.equal(`${result.stdout}${result.stderr}${summary}`.includes(secret), false);
      assert.deepEqual(readdirSync(fixture.privateFiles), []);
      const calls = readFileSync(fixture.callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls.map((args) => args[0]),
        ['api', 'config', 'api']
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('executed entry withholds provider secrets and cleans private files when native planning fails', () => {
  const fixture = entryFixture(plan(), snapshot(), true);
  try {
    const result = fixture.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Read-only Railway command failed; plan inventory unverified/u);
    const lines = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, 'owners-observed');
    assert.equal(lines[0].planVerified, false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
    assert.deepEqual(readdirSync(fixture.privateFiles), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
