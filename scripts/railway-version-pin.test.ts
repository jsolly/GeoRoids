import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { test } from 'vitest';
import { parse } from 'yaml';
import {
  railwayCli,
  readSnapshot,
  reviewPlan,
  runVersionPin,
  selectMode,
  stableJson,
} from './railway-version-pin.ts';

const production = {
  project: '08a7b6ee-af66-4c58-a21e-700d5468ee14',
  environment: '94d3de2f-4bb0-4051-8975-a30190c2fffa',
  service: '4e2cb2a2-c1e2-41a8-a970-3f60659c2524',
  name: 'Georoids',
};
const tree = 'd0a934bd14a4529689009aca626bba12a61db775d';
const oldBuild = { builder: 'RAILPACK', buildEnvironment: 'V3', railpackVersion: '0.42.0' };
const newBuild = { ...oldBuild, railpackVersion: '0.43.0' };

// Synthetic boundary fixtures transcribed from pinned official CLI source:
// iac/saved_plan.rs, iac/change_set.rs::update/changed_leaf_paths, engine.rs
// and gql/queries/strings/{EnvironmentStagedChanges,LatestDeployment}.graphql.
// They prove local policy and sequencing, never a real provider plan/apply.
function snapshot(build = oldBuild, etag = 'etag-before', deployment = 'deployment-before') {
  return {
    data: {
      environment: {
        id: production.environment,
        projectId: production.project,
        configEtag: etag,
        config: {
          services: {
            [production.service]: {
              build: { ...build },
              variables: { PRIVATE: { value: 'DO-NOT-LOG' } },
            },
          },
        },
      },
      project: {
        id: production.project,
        services: { edges: [{ node: { id: production.service, name: production.name } }] },
      },
      environmentStagedChanges: null,
      serviceInstance: { latestDeployment: { id: deployment, status: 'SUCCESS' } },
    },
  };
}
function change() {
  return {
    kind: 'resource.update',
    address: 'service.Georoids',
    field: 'build',
    before: oldBuild,
    after: newBuild,
    path: 'resources.service.Georoids.build',
    summary: 'Update Georoids build.railpackVersion',
    severity: 'safe',
    deployEffect: 'deploy',
    details: ['build.railpackVersion ("0.42.0" → "0.43.0")'],
  };
}
function artifact(changes: unknown[] = [change()]) {
  return rehash({
    kind: 'railway.config.plan',
    version: 1,
    cliVersion: '5.50.2',
    sourceTree: tree,
    environmentId: production.environment,
    configEtag: 'etag-before',
    destructive: false,
    changeSetHash: '',
    diff: '~ Update Georoids build.railpackVersion',
    changeSet: {
      version: 1,
      changes,
      diagnostics: [],
      declared: ['volume.world-data', 'service.Georoids'],
      telemetry: { language: 'typescript' },
    },
  });
}
function rehash<T extends { changeSet: unknown; changeSetHash: string }>(plan: T): T {
  plan.changeSetHash = `sha256:${createHash('sha256').update(stableJson(plan.changeSet)).digest('hex')}`;
  return plan;
}
function review(value: unknown, before = snapshot()) {
  return reviewPlan(value, { sourceTree: tree, version: '0.43.0', snapshot: readSnapshot(before) });
}

test('the reviewed whole-build update admits only a version change and a converged no-op', () => {
  assert.deepEqual(review(artifact()), { kind: 'pin', previous: '0.42.0', version: '0.43.0' });
  assert.deepEqual(review(artifact([]), snapshot(newBuild)), { kind: 'noop' });
  assert.throws(() => review(artifact([])), /Empty plan/u);
  assert.throws(
    () =>
      review(
        artifact([
          {
            ...change(),
            before: newBuild,
            details: ['build.railpackVersion ("0.43.0" → "0.43.0")'],
          },
        ]),
        snapshot(newBuild)
      ),
    /changes more/u
  );
  const firstPin = artifact([
    {
      ...change(),
      before: { builder: 'RAILPACK', buildEnvironment: 'V3' },
      details: ['build.railpackVersion (null → "0.43.0")'],
    },
  ]);
  const before = snapshot();
  Reflect.deleteProperty(
    before.data.environment.config.services[production.service]?.build ?? {},
    'railpackVersion'
  );
  assert.deepEqual(review(firstPin, before), {
    kind: 'pin',
    previous: undefined,
    version: '0.43.0',
  });
});

test('saved artifact identity, source, etag and hash fail closed', () => {
  for (const patch of [
    { kind: 'other' },
    { version: 2 },
    { cliVersion: '5.50.3' },
    { sourceTree: 'stale' },
    { environmentId: 'preview' },
    { configEtag: 'stale' },
    { destructive: true },
    { claim: true },
    { changeSetHash: 'sha256:tampered' },
    { diff: {} },
    { extra: 'unreviewed' },
  ]) {
    assert.throws(() => review({ ...artifact(), ...patch }));
  }
  assert.throws(
    () => review({ ...artifact(), changeSet: { ...artifact().changeSet, changes: [] } }),
    /hash/u
  );
  for (const patch of [
    { version: 2 },
    { changes: null },
    { diagnostics: [{ severity: 'warning' }] },
    { declared: ['service.other'] },
    { partial: 'claim' },
    { telemetry: { language: 'unknown' } },
  ]) {
    assert.throws(() =>
      review(rehash({ ...artifact(), changeSet: { ...artifact().changeSet, ...patch } }))
    );
  }
});

test('unknown, destructive, unrelated, hidden and stale changes cannot pass as a version update', () => {
  const changes = [
    { ...change(), kind: 'resource.delete' },
    { ...change(), address: 'service.other' },
    { ...change(), field: 'deploy' },
    { ...change(), path: 'resources.service.other.build' },
    { ...change(), severity: 'destructive' },
    { ...change(), deployEffect: 'none' },
    { ...change(), details: ['build.buildCommand'] },
    { ...change(), injected: 'secret' },
    { ...change(), summary: null },
    {
      ...change(),
      before: { ...oldBuild, railpackVersion: '0.41.0' },
      details: ['build.railpackVersion ("0.41.0" → "0.43.0")'],
    },
    { ...change(), after: { ...newBuild, railpackVersion: '0.44.0' } },
    { ...change(), after: { ...newBuild, builder: 'DOCKERFILE' } },
    { ...change(), after: { ...newBuild, buildEnvironment: 'V2' } },
    { ...change(), after: { ...newBuild, buildCommand: 'unreviewed command' } },
    { ...change(), after: { ...newBuild, railpackVersion: 'latest' } },
  ];
  for (const forbidden of changes) {
    assert.throws(() => review(artifact([forbidden])));
  }
  assert.throws(() => review(artifact([change(), { kind: 'variable.set', value: 'DO-NOT-LOG' }])));
});

test('live target and every non-null staged response block before a plan can run', async () => {
  const live = snapshot();
  const forbidden: unknown[] = [
    null,
    [],
    {},
    { ...live, errors: [{ message: 'DO-NOT-LOG' }] },
    { data: { ...live.data, environmentStagedChanges: {} } },
    { data: { ...live.data, environmentStagedChanges: { id: 'unrelated', status: 'staged' } } },
    { data: { ...live.data, environmentStagedChanges: undefined } },
    { data: { ...live.data, environment: { ...live.data.environment, id: 'preview' } } },
    { data: { ...live.data, project: { ...live.data.project, id: 'other' } } },
    {
      data: {
        ...live.data,
        project: {
          ...live.data.project,
          services: { edges: [{ node: { id: production.service, name: 'Other service' } }] },
        },
      },
    },
    {
      data: {
        ...live.data,
        project: {
          ...live.data.project,
          services: { edges: [{ node: { id: 'other', name: production.name } }] },
        },
      },
    },
  ];
  for (const response of forbidden) {
    const calls: string[][] = [];
    await assert.rejects(
      runVersionPin(
        options({
          railway: (args) => {
            calls.push(args);
            return Promise.resolve(JSON.stringify(response));
          },
        })
      )
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], 'api');
  }
});

function options(
  overrides: Partial<Parameters<typeof runVersionPin>[0]> = {}
): Parameters<typeof runVersionPin>[0] {
  return {
    railway: () => Promise.reject(new Error('Unexpected provider call')),
    planPath: '/private/plan.json',
    readPlan: async () => JSON.stringify(artifact()),
    sourceTree: tree,
    desiredVersion: '0.43.0',
    apply: true,
    assertSource: async () => {},
    sleep: async () => {},
    smoke: async () => {},
    ...overrides,
  };
}
// Candidate terminal-policy fixture, not a captured apply result. The public
// schema does not enumerate aggregate status or the JSON diagnostics shape.
function applied() {
  return {
    id: 'apply-id',
    status: 'applied',
    deploymentId: 'deployment-after',
    stagedPatchId: null,
    diagnostics: [],
    changes: [
      { kind: 'resource.update', status: 'applied', path: 'resources.service.Georoids.build' },
    ],
  };
}
function provider({
  post = snapshot(newBuild, 'etag-after', 'deployment-after'),
  applyResult = applied(),
  deploymentStatus = 'SUCCESS',
  driver = '0.43.0',
}: {
  post?: unknown;
  applyResult?: unknown;
  deploymentStatus?: string;
  driver?: string;
} = {}) {
  const calls: string[][] = [];
  let snapshots = 0;
  return {
    calls,
    railway: (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1]?.includes('VersionPinSnapshot')) {
        return Promise.resolve(JSON.stringify(++snapshots <= 2 ? snapshot() : post));
      }
      if (args[0] === 'config' && args[1] === 'plan') {
        return Promise.resolve('{}');
      }
      if (args[0] === 'config' && args[1] === 'apply') {
        return Promise.resolve(JSON.stringify(applyResult));
      }
      if (args[0] === 'api' && args[1]?.includes('VersionPinDeployment')) {
        return Promise.resolve(
          JSON.stringify({ data: { deployment: { status: deploymentStatus } } })
        );
      }
      if (args[0] === 'logs') {
        return Promise.resolve(
          JSON.stringify({ message: `using build driver railpack-v${driver}` })
        );
      }
      throw new Error('Unexpected command');
    },
  };
}

test('only the validated saved file is applied and actual readback/build/smoke precede success', async () => {
  const transport = provider();
  let smoked = false;
  const receipt = await runVersionPin(
    options({
      railway: transport.railway,
      smoke: () => {
        assert.equal(transport.calls.at(-1)?.[0], 'logs');
        smoked = true;
        return Promise.resolve();
      },
    })
  );
  assert.equal(smoked, true);
  assert.deepEqual(
    transport.calls.filter((args) => args[0] === 'logs'),
    [
      [
        'logs',
        'deployment-after',
        '--build',
        '--json',
        '--lines',
        '1000',
        '--project',
        production.project,
        '--environment',
        production.environment,
        '--service',
        production.service,
      ],
    ]
  );
  for (const args of transport.calls) {
    assert.equal(
      args.some((arg) =>
        [
          '--decrypt-variables',
          '--include-variables',
          '--show-values',
          '--confirm-destructive',
        ].includes(arg)
      ),
      false
    );
    if (args[0] === 'api' && args[1]?.includes('VersionPinSnapshot')) {
      assert.ok(args[1].includes('config(decryptVariables: false)'));
      assert.equal(
        args[3],
        JSON.stringify({
          projectId: production.project,
          environmentId: production.environment,
          serviceId: production.service,
        })
      );
    }
  }
  assert.deepEqual(
    transport.calls.find((args) => args[1] === 'apply'),
    ['config', 'apply', '--plan', '/private/plan.json', '--yes', '--json']
  );
  assert.deepEqual(receipt, {
    outcome: 'verified',
    change: 'pin',
    version: '0.43.0',
    deploymentId: 'deployment-after',
  });
  assert.equal(JSON.stringify(receipt).includes('DO-NOT-LOG'), false);
});

test('plan-only never applies, reads build logs or claims production verification', async () => {
  const transport = provider();
  const receipt = await runVersionPin(options({ railway: transport.railway, apply: false }));
  assert.deepEqual(receipt, {
    outcome: 'plan-only',
    change: 'pin',
    version: '0.43.0',
    deploymentId: null,
  });
  assert.equal(
    transport.calls.some((args) => args[1] === 'apply' || args[0] === 'logs'),
    false
  );
});

test('changed staged state, etag, source and saved bytes stop before apply', async () => {
  for (const next of [
    { data: { ...snapshot().data, environmentStagedChanges: { id: 'new-work' } } },
    snapshot(oldBuild, 'different-etag'),
  ]) {
    const transport = provider();
    let reads = 0;
    const railway = async (args: string[]) =>
      args[0] === 'api' && args[1]?.includes('VersionPinSnapshot') && ++reads === 2
        ? JSON.stringify(next)
        : transport.railway(args);
    await assert.rejects(runVersionPin(options({ railway })));
    assert.equal(
      transport.calls.some((args) => args[1] === 'apply'),
      false
    );
  }
  for (const override of [
    {
      assertSource: (() => {
        let checks = 0;
        return () =>
          ++checks === 2 ? Promise.reject(new Error('Merged main changed')) : Promise.resolve();
      })(),
    },
    {
      readPlan: (() => {
        let reads = 0;
        return async () =>
          JSON.stringify({ ...artifact(), ...(++reads === 2 ? { diff: 'tampered bytes' } : {}) });
      })(),
    },
  ]) {
    const transport = provider();
    await assert.rejects(runVersionPin(options({ railway: transport.railway, ...override })));
    assert.equal(
      transport.calls.some((args) => args[1] === 'apply'),
      false
    );
  }
});

test('missing apply/deployment/readback/driver/smoke evidence fails after apply without retrying it', async () => {
  const cases = [
    { applyResult: { status: 'applying' } },
    { applyResult: { status: 'failed' } },
    { applyResult: { ...applied(), status: 'unknown' } },
    { applyResult: { ...applied(), deploymentId: null } },
    { applyResult: { ...applied(), stagedPatchId: 'unrelated-work' } },
    { applyResult: { ...applied(), diagnostics: [{ severity: 'warning' }] } },
    {
      applyResult: {
        ...applied(),
        changes: [
          {
            kind: 'resource.update',
            status: 'failed',
            path: 'resources.service.Georoids.build',
          },
        ],
      },
    },
    { applyResult: { ...applied(), unreviewed: 'field' } },
    { deploymentStatus: 'FAILED' },
    { deploymentStatus: 'NEW_UNKNOWN_STATUS' },
    { post: snapshot(oldBuild, 'etag-after', 'deployment-after') },
    { post: snapshot(newBuild, 'etag-after', 'deployment-other') },
    { driver: '0.42.0' },
    { driver: '' },
    { driver: '0.43.0 using build driver railpack-v0.42.0' },
    {
      post: {
        data: {
          ...snapshot(newBuild, 'etag-after', 'deployment-after').data,
          environmentStagedChanges: { id: 'new-work' },
        },
      },
    },
  ];
  for (const scenario of cases) {
    const transport = provider(scenario);
    let smoked = false;
    await assert.rejects(
      runVersionPin(
        options({
          railway: transport.railway,
          smoke: () => {
            smoked = true;
            return Promise.resolve();
          },
        })
      )
    );
    assert.equal(smoked, false);
    assert.equal(transport.calls.filter((args) => args[1] === 'apply').length, 1);
  }
  const transport = provider();
  await assert.rejects(
    runVersionPin(
      options({
        railway: transport.railway,
        smoke: () => Promise.reject(new Error('Gameplay failed')),
      })
    )
  );
  assert.equal(transport.calls.filter((args) => args[1] === 'apply').length, 1);
});

test('a converged retry verifies its existing successful deployment without applying again', async () => {
  const transport = provider();
  const railway = async (args: string[]) =>
    args[0] === 'api' && args[1]?.includes('VersionPinSnapshot')
      ? JSON.stringify(snapshot(newBuild, 'etag-before', 'deployment-after'))
      : transport.railway(args);
  const receipt = await runVersionPin(
    options({ railway, readPlan: async () => JSON.stringify(artifact([])) })
  );
  assert.equal(receipt.outcome, 'verified');
  assert.equal(receipt.change, 'noop');
  assert.equal(
    transport.calls.some((args) => args[1] === 'apply'),
    false
  );
});

test('workflow is hard-disabled, production serialized, and secrets reach only the guarded runner', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/railway-version-pin.yml', import.meta.url), 'utf8')
  );
  assert.equal(
    workflow.jobs.pin.if,
    "github.repository == 'jsolly/GeoRoids' && github.repository == 'DISABLED/REQUIRES-APPROVAL' && github.ref == 'refs/heads/main'"
  );
  assert.equal(workflow.concurrency.group, 'railway-production-version-pin');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.pin.environment, 'railway-production-config');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode, {
    description: 'Plan only, or apply after separate production apply authorization',
    required: true,
    type: 'choice',
    default: 'plan-only',
    options: ['plan-only', 'apply'],
  });
  const steps = workflow.jobs.pin.steps;
  for (const step of steps.filter((candidate: { uses?: string }) => candidate.uses)) {
    assert.match(step.uses, /@[a-f0-9]{40}$/u);
  }
  const secrets = steps.filter(
    (step: { env?: Record<string, string> }) => step.env?.['RAILWAY_CONFIG_TOKEN']
  );
  assert.equal(secrets.length, 1);
  assert.equal(
    secrets[0].run,
    'umask 077\nnode --import tsx scripts/railway-version-pin-entry.ts --workflow-mode\n'
  );
  assert.match(secrets[0].env.RAILWAY_CONFIG_TOKEN, /^\$\{\{ secrets.RAILWAY_CONFIG_TOKEN \}\}$/u);
  assert.match(
    secrets[0].env.RAILWAY_CONFIG_MODE,
    /github\.event_name == 'workflow_dispatch' && inputs\.mode/u
  );
  assert.match(
    secrets[0].env.RAILWAY_CONFIG_MODE,
    /vars\.RAILWAY_CONFIG_APPLY_ENABLED == 'true' && 'apply' \|\| 'plan-only'/u
  );
  assert.match(
    secrets[0].env.RAILWAY_CONFIG_APPLY_ENABLED,
    /vars\.RAILWAY_CONFIG_APPLY_ENABLED == 'true' && 'version-pin-only' \|\| 'disabled'/u
  );
  const install = steps.find(
    (step: { name?: string }) => step.name === 'Install checksum-pinned official Railway CLI'
  );
  assert.ok(
    install.run.includes(
      `/v${railwayCli.version}/railway-v${railwayCli.version}-x86_64-unknown-linux-musl.tar.gz`
    )
  );
  assert.ok(install.run.includes(railwayCli.archiveSha256));
  assert.ok(install.run.includes(railwayCli.binarySha256));
  assert.equal(
    steps.some((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@')),
    false
  );
});

test('deployment timeout is bounded and never retries apply', async () => {
  const transport = provider({ deploymentStatus: 'BUILDING' });
  let sleeps = 0;
  await assert.rejects(
    runVersionPin(
      options({
        railway: transport.railway,
        sleep: () => {
          sleeps++;
          return Promise.resolve();
        },
      })
    ),
    /timed out/u
  );
  assert.equal(sleeps, 120);
  assert.equal(transport.calls.filter((args) => args[1] === 'apply').length, 1);
});

test('entry refuses production apply before any CLI use and withholds private inputs', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/railway-version-pin-entry.ts', '--apply'],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env['PATH'],
        RAILWAY_CONFIG_TOKEN: 'DO-NOT-LOG',
        RAILWAY_CONFIG_CLI: '/must-not-execute',
      },
    }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Railway version-pin verification failed\./u);
  assert.match(result.stderr, /Production apply is disabled/u);
  assert.equal(result.stderr.includes('DO-NOT-LOG'), false);
  assert.equal(result.stderr.includes('/must-not-execute'), false);
});

test('a production change during smoke prevents a verified receipt', async () => {
  const transport = provider();
  let smoked = false;
  await assert.rejects(
    runVersionPin(
      options({
        railway: async (args) => {
          const response = await transport.railway(args);
          return smoked && args[0] === 'api' && args[1]?.includes('VersionPinSnapshot')
            ? JSON.stringify(snapshot(oldBuild, 'etag-after', 'deployment-after'))
            : response;
        },
        smoke: () => {
          smoked = true;
          return Promise.resolve();
        },
      })
    ),
    /changed during/u
  );
  assert.equal(smoked, true);
});

test('canonical hashing orders nested keys without changing arrays or values', () => {
  assert.equal(
    stableJson({ z: 2, a: { z: [false, null], x: 1 } }),
    '{"a":{"x":1,"z":[false,null]},"z":2}'
  );
});

test('malformed private API and saved-plan data stop before apply with a fixed local error', async () => {
  for (const boundary of ['api', 'plan']) {
    const transport = provider();
    await assert.rejects(
      runVersionPin(
        options({
          railway: boundary === 'api' ? () => Promise.resolve('{DO-NOT-LOG') : transport.railway,
          readPlan: boundary === 'plan' ? () => Promise.resolve('{DO-NOT-LOG') : options().readPlan,
        })
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Railway returned malformed JSON');
        assert.equal(error.message.includes('DO-NOT-LOG'), false);
        return true;
      }
    );
    assert.equal(
      transport.calls.some((args) => args[1] === 'apply'),
      false
    );
  }
});

test('workflow mode is validated as data and cannot turn plan-only into apply', () => {
  assert.equal(selectMode({ args: ['--workflow-mode'], workflowMode: 'plan-only' }), 'plan-only');
  assert.equal(selectMode({ args: ['--workflow-mode'], workflowMode: 'apply' }), 'apply');
  assert.equal(selectMode({ args: ['--plan-only'], workflowMode: 'apply' }), 'plan-only');
  assert.equal(selectMode({ args: ['--apply'], workflowMode: 'plan-only' }), 'apply');
  for (const workflowMode of [
    undefined,
    null,
    true,
    '',
    '--apply',
    'apply; execute-unreviewed',
    'apply\n',
  ]) {
    assert.throws(() => selectMode({ args: ['--workflow-mode'], workflowMode }));
  }
  for (const args of [[], ['--apply', '--plan-only'], ['--unknown']]) {
    assert.throws(() => selectMode({ args, workflowMode: 'apply' }));
  }
});

test('selecting apply in the trusted workflow still requires the separate apply control', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/railway-version-pin-entry.ts', '--workflow-mode'],
    {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env['PATH'],
        RAILWAY_CONFIG_MODE: 'apply',
        RAILWAY_CONFIG_TOKEN: 'DO-NOT-LOG',
        RAILWAY_CONFIG_CLI: '/must-not-execute',
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'jsolly/GeoRoids',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
      },
    }
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Production apply is disabled/u);
  assert.equal(result.stderr.includes('DO-NOT-LOG'), false);
});
