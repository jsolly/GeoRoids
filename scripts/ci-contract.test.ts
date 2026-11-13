import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'vitest';
import { parse } from 'yaml';

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): RecordValue {
  assert.ok(isRecord(value), 'Expected a mapping');
  return value;
}

function optionalString(value: unknown): string | undefined {
  assert.ok(value === undefined || typeof value === 'string', 'Expected a string');
  return value;
}

function strings(value: unknown): Record<string, string> {
  const entries = Object.entries(record(value));
  return Object.fromEntries(
    entries.map(([key, item]) => {
      assert.ok(typeof item === 'string', `Expected string value for ${key}`);
      return [key, item];
    })
  );
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'Expected a list');
  return value.map((item: unknown) => {
    assert.ok(typeof item === 'string', 'Expected a string entry');
    return item;
  });
}

function requiredString(value: string | undefined): string {
  assert.ok(typeof value === 'string', 'Missing required string');
  return value;
}

function at<T>(items: T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined, `Missing entry ${index}`);
  return value;
}

interface Step {
  name: string | undefined;
  id: string | undefined;
  uses: string | undefined;
  if: string | undefined;
  run: string | undefined;
  env: Record<string, string>;
  with: RecordValue;
  'continue-on-error': unknown;
}

interface Job {
  name: string | undefined;
  needs: string | string[] | undefined;
  if: string | undefined;
  steps: Step[];
  env: Record<string, string>;
  environment: unknown;
  concurrency: unknown;
  'runs-on': unknown;
  'timeout-minutes': unknown;
  'continue-on-error': unknown;
}

function workflow(value: unknown) {
  const workflowFields = record(value);
  return {
    ...workflowFields,
    on: Object.fromEntries(
      Object.entries(record(workflowFields['on'])).map(([name, event]) => [
        name,
        {
          types: isRecord(event) && event['types'] !== undefined ? stringArray(event['types']) : [],
        },
      ])
    ),
    jobs: Object.fromEntries(
      Object.entries(record(workflowFields['jobs'])).map(([name, entry]): [string, Job] => {
        const jobFields = record(entry);
        const needs = jobFields['needs'];
        const steps: unknown = jobFields['steps'];
        assert.ok(Array.isArray(steps), `${name} must have steps`);
        return [
          name,
          {
            ...jobFields,
            name: optionalString(jobFields['name']),
            needs: typeof needs === 'string' || needs === undefined ? needs : stringArray(needs),
            if: optionalString(jobFields['if']),
            env: strings(jobFields['env'] ?? {}),
            environment: jobFields['environment'],
            concurrency: jobFields['concurrency'],
            'runs-on': jobFields['runs-on'],
            'timeout-minutes': jobFields['timeout-minutes'],
            'continue-on-error': jobFields['continue-on-error'],
            steps: steps.map((stepValue: unknown): Step => {
              const data = record(stepValue);
              return {
                ...data,
                name: optionalString(data['name']),
                id: optionalString(data['id']),
                uses: optionalString(data['uses']),
                if: optionalString(data['if']),
                run: optionalString(data['run']),
                env: strings(data['env'] ?? {}),
                with: record(data['with'] ?? {}),
                'continue-on-error': data['continue-on-error'],
              };
            }),
          },
        ];
      })
    ),
    permissions: workflowFields['permissions'],
    concurrency: workflowFields['concurrency'],
  };
}

function requiredJob(value: ReturnType<typeof workflow>, name: string): Job {
  const selected = value.jobs[name];
  assert.ok(selected, `Missing job ${name}`);
  return selected;
}

function requiredStep(steps: Step[], index: number): Step {
  const selected = steps[index];
  assert.ok(selected, `Missing step ${index}`);
  return selected;
}

function manifestValue(source: string) {
  const data = record(JSON.parse(source));
  return { scripts: strings(data['scripts']), devDependencies: record(data['devDependencies']) };
}

interface PreviewOptions {
  apiFailure?: boolean;
  fork?: boolean;
  closed?: boolean;
  mismatch?: boolean;
  symlink?: boolean;
  uploadFailure?: boolean;
  stale?: boolean;
  healthFailure?: boolean;
  htmlFailure?: boolean;
  permissionFailure?: boolean;
  badHead?: boolean;
  comment?: string;
  author?: string;
  permission?: string;
}

function fixtureCall(source: string) {
  const data = record(JSON.parse(source));
  assert.ok(typeof data['command'] === 'string');
  return { command: data['command'], args: stringArray(data['args'] ?? []) };
}

test('CI preserves six mandatory lanes and failure propagation', () => {
  const root = new URL('../', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
  const ci = workflow(parse(read('.github/workflows/ci.yml')));
  const coverage = workflow(parse(read('.github/workflows/coverage.yml')));
  const required = requiredJob(ci, 'ci');
  assert.ok(Array.isArray(required.needs));
  // ci.yml pins the checkout and artifact actions every lane shares to full commits, each with its
  // release as a comment, so no lane runs a tag that can be moved under it.
  const checkoutAction = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
  const uploadArtifactAction = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';
  const usesLines = read('.github/workflows/ci.yml')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:- )?uses: actions\/(?:checkout|upload-artifact)@/u.test(line));
  assert.ok(usesLines.length > 0);
  for (const line of usesLines) {
    assert.ok(
      [`uses: ${checkoutAction}  # v7.0.1`, `uses: ${uploadArtifactAction}  # v7.0.2`].includes(
        line.replace(/^- /u, '')
      ),
      `ci.yml must use the pinned checkout or upload-artifact commit: ${line}`
    );
  }
  assert.deepEqual(required.needs, [
    'static-checks',
    'runner-contracts',
    'actions-contracts',
    'integration-tests',
    'wiki-media',
    'railpack-build',
  ]);
  // The required check runs whenever its lanes run, Dependabot PRs included, and fails when any
  // of its steps fails. Labels start no runs.
  assert.equal(ci.on['pull_request']?.types.includes('labeled'), false);
  assert.equal(required.if, 'always()');
  assert.equal(required.name, 'ci');
  assert.equal(required['continue-on-error'], undefined, 'ci must fail when it fails');
  assert.deepEqual(
    required.steps
      .filter((step) => step['continue-on-error'] !== undefined || step.if !== undefined)
      .map((step) => step.name ?? step.uses),
    []
  );
  for (const name of required.needs) {
    assert.equal(
      requiredJob(ci, name).needs,
      undefined,
      `${name} must start without waiting for another lane`
    );
    assert.equal(
      requiredJob(ci, name)['timeout-minutes'],
      new Map([
        ['actions-contracts', 6],
        ['railpack-build', 10],
      ]).get(name) ?? 4
    );
    // The committed Wiki media baseline belongs to linux-x64, and Railway builds the server on
    // x64; every other lane runs on arm64.
    assert.equal(
      requiredJob(ci, name)['runs-on'],
      ['wiki-media', 'railpack-build'].includes(name) ? 'ubuntu-24.04' : 'ubuntu-24.04-arm'
    );
    assert.equal(requiredJob(ci, name).if, undefined);
    assert.equal(requiredJob(ci, name).name, name);
    // Only the reusable-tree lookup may fail without failing its lane.
    assert.equal(
      requiredJob(ci, name)['continue-on-error'],
      undefined,
      `${name} must fail when it fails`
    );
    assert.deepEqual(
      requiredJob(ci, name)
        .steps.filter((step) => step['continue-on-error'] !== undefined)
        .map((step) => step.id),
      ['verified-tree']
    );
  }
  // Secrets scan precedes reusable-tree decisions in each independently validated lane.
  for (const name of required.needs) {
    const steps = requiredJob(ci, name).steps;
    assert.equal(requiredStep(steps, 0).uses, checkoutAction);
    assert.equal(requiredStep(steps, 0).with['fetch-depth'], 0);
    assert.equal(requiredStep(steps, 0).with['persist-credentials'], false);
    assert.equal(requiredStep(steps, 1).name, 'Secrets scan (range)');
    assert.equal(requiredStep(steps, 1).if, undefined);
    assert.match(requiredString(requiredStep(steps, 1).run), /sha256sum --check/u);
    assert.match(requiredString(requiredStep(steps, 1).run), /--text/u);
    assert.match(requiredString(requiredStep(steps, 1).run), /--diff-merges=remerge/u);
    assert.equal(
      requiredStep(steps, 1).run,
      requiredStep(requiredJob(ci, 'static-checks').steps, 1).run
    );
    assert.equal(requiredStep(steps, 2).id, 'verified-tree');
    assert.equal(requiredStep(steps, 2).run, 'bash scripts/ci-verified-tree.sh');
    const proof = steps.find((step) => step.name === 'Record validated PR tree');
    assert.ok(proof);
    assert.equal(proof.uses, uploadArtifactAction);
    assert.equal(
      proof.with['name'],
      `ci-tree-v1-\${{ github.job }}-\${{ steps.verified-tree.outputs.tree }}-\${{ github.run_attempt }}`
    );
    assert.equal(proof.with['path'], `\${{ runner.temp }}/ci-tree-\${{ github.job }}.txt`);
    assert.match(requiredString(proof.if), /success\(\)/u);
  }
  assert.deepEqual(Object.keys(coverage.on), ['workflow_dispatch']);
  assert.equal(
    manifestValue(read('package.json')).scripts['gate'],
    'FLEET_DOC_FAST=0 bash .git-hooks/pre-commit'
  );
  const hook = read('.git-hooks/pre-commit');
  assert.match(hook, /^node scripts\/gate\.mjs$/mu);
  assert.doesNotMatch(hook, /run_step\s+"complete gate"/u);
  assert.doesNotMatch(read('scripts/gate.mjs'), /pre-commit|npm.*gate/u);
  assert.equal(
    manifestValue(read('package.json')).scripts['test:review'],
    'bash scripts/test-review.sh'
  );

  // Every caller runs one anchored body. The aggregate's pinned arm64 runner selects
  // its original archive; x64 lanes select the independently pinned x64 archive.
  const laneScan = requiredString(requiredStep(requiredJob(ci, 'static-checks').steps, 1).run);
  assert.equal(required['runs-on'], 'ubuntu-24.04-arm');
  assert.match(laneScan, /^ {2}ARM64\) gitleaks_arch=arm64 gitleaks_sha256=[0-9a-f]{64} ;;$/mu);
  assert.match(laneScan, /^ {2}X64\) gitleaks_arch=x64 gitleaks_sha256=[0-9a-f]{64} ;;$/mu);
  const aggregateScan = required.steps.find((step) => step.name === 'Secrets scan (range)');
  assert.ok(aggregateScan);
  assert.equal(laneScan, aggregateScan.run);

  // Moving a check between lanes must neither remove nor duplicate a validation.
  const commandsByLane = {
    'static-checks': [
      'npm run check:repo-hooks',
      'npm run check:python',
      'npm run check:lint-policy',
      'npm run check:lint',
      'npm run check:knip',
      'npm run check:ts-prune',
      'npm run check:members',
      'npm run check:md',
      'npm run check:yaml',
      'npm run check:ts',
      'npm run check:frontend',
      'npm run check:format',
      'npm run check:benchmarks',
      'npm run build',
    ],
    'runner-contracts': ['npm run check:test-runner', 'npm run check:dev-server'],
    'actions-contracts': ['npm run check:actions'],
    'integration-tests': [],
    'wiki-media': [
      'npm run wiki:media:check',
      'npm run wiki:media -- --output "$RUNNER_TEMP/wiki-media-baseline"',
    ],
    'railpack-build': [],
  } satisfies Record<string, string[]>;
  assert.deepEqual(
    [...required.needs].sort((left, right) => left.localeCompare(right)),
    Object.keys(commandsByLane).sort((left, right) => left.localeCompare(right))
  );
  const commands: string[] = [];
  for (const [name, expected] of Object.entries(commandsByLane)) {
    const checks = requiredJob(ci, name).steps.filter(
      (step): step is Step & { run: string } =>
        typeof step.run === 'string' && /^npm run /u.test(step.run)
    );
    assert.deepEqual(
      checks.map((step) => step.run),
      expected,
      `${name}: command inventory`
    );
    commands.push(...checks.map((step) => step.run));
    // A moved check must still run on every full validation, except the media
    // candidate that is deliberately rendered only after baseline verification fails.
    for (const command of checks) {
      assert.equal(
        command.if,
        command.run === commandsByLane['wiki-media'][1]
          ? "failure() && steps.wiki-media.outcome == 'failure'"
          : "steps.verified-tree.outputs.run_full != 'false'",
        `${name}: ${command.run}`
      );
    }
  }
  assert.equal(new Set(commands).size, commands.length, 'No command may run in two lanes');

  // The replacement lane executes the complete default code inventory and binds
  // retained reports to its source/runtime/cleanup receipt before it can pass.
  const integrationSteps = requiredJob(ci, 'integration-tests').steps;
  const integration = integrationSteps.find(
    (step) => step.name === 'Run complete code integration inventory'
  );
  assert.ok(integration);
  assert.equal(integration.if, "steps.verified-tree.outputs.run_full != 'false'");
  assert.equal(
    integration.env['GEOROIDS_CODE_INTEGRATION_RECEIPT'],
    `\${{ github.workspace }}/.performance/ci-code-integration/runner.json`
  );
  assert.match(
    requiredString(integration.run),
    /GEOROIDS_TEST_MAX_DURATION_SECONDS=150 \.\/scripts\/test-runner\.sh \\\n\s+--reporter=verbose 2>&1 \| tee \.performance\/ci-code-integration\/test-run\.log/u
  );
  assert.match(
    requiredString(integration.run),
    /validateCodeIntegrationReceipt\(process\.env\.GEOROIDS_CODE_INTEGRATION_RECEIPT\)/u
  );
  assert.doesNotMatch(
    requiredString(integration.run),
    /tests\/integration\/|--exclude|--shard|testNamePattern/u
  );
  const integrationUpload = integrationSteps.find(
    (step) => step.name === 'Upload code integration artifacts'
  );
  assert.ok(integrationUpload);
  assert.equal(integrationUpload.with['path'], '.performance/ci-code-integration');
  assert.equal(integrationUpload.with['include-hidden-files'], true);
  assert.equal(integrationUpload.with['if-no-files-found'], 'error');
  assert.match(requiredString(integrationUpload.if), /always\(\)/u);
  for (const job of Object.values(ci.jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(
        step.run ?? '',
        /playwright install|chromium|webkit|tests\/integration\/browser/u
      );
    }
  }
  const manifest = manifestValue(read('package.json'));
  // Manual measurements are explicit user entrypoints, never hidden validation.
  const manualMeasurement =
    /playwright|puppeteer|--benchmark-(?:client|load)|benchmark:(?:realtime|load)|measure-frame-work/u;
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (/^(?:test(?::|$)|check:|gate$|fix$)/u.test(name)) {
      assert.doesNotMatch(command, manualMeasurement, `${name} must remain code-only validation`);
      // Wiki media belongs to linux-x64 and its CI lane; local validation must pass on macOS too.
      assert.doesNotMatch(
        command,
        /wiki:media|wiki-media\.ts/u,
        `${name} must not render Wiki media`
      );
    }
  }
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/production-smoke.yml']) {
    const candidate = workflow(parse(read(file)));
    for (const job of Object.values(candidate.jobs)) {
      for (const step of job.steps) {
        assert.doesNotMatch(
          step.run ?? '',
          manualMeasurement,
          `${file} must not invoke manual measurements`
        );
      }
    }
  }
  assert.equal(manifest.scripts['test:integration'], './scripts/test-runner.sh --reporter=verbose');
  assert.equal(manifest.scripts['test:all'], 'npm run test && npm run test:integration');
  assert.equal(
    manifest.scripts['check:test-runner'],
    'node scripts/validation-admission.mjs contracts -- bash scripts/test-runner-contract.sh'
  );
  assert.match(
    read('scripts/test-runner-contract.sh'),
    /^exec node node_modules\/vitest\/vitest\.mjs run --config config\/testing\/tooling\.ts --project runner$/mu
  );
  assert.equal(
    manifest.scripts['check:actions'],
    'vitest run --config config/testing/tooling.ts --project actions --project smoke && bash scripts/check-actions.sh'
  );
  assert.equal(
    manifest.scripts['smoke:production'],
    'node --import tsx scripts/production-smoke-entry.mjs'
  );
  assert.equal(
    manifest.scripts['smoke:scenario-contract'],
    'vitest run --config config/testing/tooling.ts --project smoke'
  );
  assert.equal(
    manifest.scripts['check:repo-hooks'],
    'uvx --from pytest==9.0.2 pytest -c config/testing/pytest.ini --rootdir=.'
  );
  // Deployment builders provide Node; Python analysis belongs to provisioned CI/gates.
  assert.equal(manifest.scripts['check:wiki'], 'tsx scripts/wiki-check.ts');
  assert.equal(manifest.scripts['check:python'], 'bash scripts/check-python-types.sh');
  assert.doesNotMatch(requiredString(manifest.scripts['build']), /\bcheck:python\b/u);
  assert.ok(
    manifest.devDependencies['playwright'],
    'Manual browser benchmarks and frame measurements still need Playwright'
  );
  assert.equal(
    manifest.scripts['benchmark:realtime'],
    './scripts/test-runner.sh --benchmark-client'
  );
  assert.equal(manifest.scripts['benchmark:load'], './scripts/test-runner.sh --benchmark-load');
  for (const command of Object.keys(manifest.scripts)) {
    assert.doesNotMatch(command, /^test:integration:(?:browser|sharded)/u);
  }
  const production = workflow(parse(read('.github/workflows/production-smoke.yml')));
  assert.doesNotMatch(
    read('.github/workflows/production-smoke.yml'),
    /playwright install|chromium|webkit/u
  );
  const releaseGuard = requiredJob(production, 'smoke').steps.find(
    (step) => step.name === 'Verify the release belongs to main'
  )?.run;
  assert.equal(
    releaseGuard,
    '[[ "$PRODUCTION_SMOKE_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1\ngit merge-base --is-ancestor "$PRODUCTION_SMOKE_RELEASE_SHA" origin/main\n'
  );
  assert.equal(requiredStep(requiredJob(production, 'smoke').steps, 0).with['fetch-depth'], 0);
  assert.match(
    requiredString(requiredJob(production, 'smoke').if),
    /github\.event\.deployment\.ref == 'main'/u
  );
  assert.match(
    requiredString(requiredJob(production, 'smoke').if),
    /github\.event\.deployment\.ref == 'refs\/heads\/main'/u
  );
  assert.match(
    requiredString(requiredJob(production, 'smoke').if),
    /github\.event\.deployment\.ref == github\.event\.deployment\.sha/u
  );
  assert.ok(
    requiredString(requiredJob(production, 'smoke').if).includes(
      "github.event.deployment_status.environment_url == 'https://railway.com/project/08a7b6ee-af66-4c58-a21e-700d5468ee14?environmentId=94d3de2f-4bb0-4051-8975-a30190c2fffa'"
    )
  );
  const productionCommands = requiredJob(production, 'smoke')
    .steps.map((step) => step.run)
    .filter(Boolean);
  assert.deepEqual(productionCommands, [
    releaseGuard,
    'npm ci',
    'npm run smoke:scenario-contract',
    'npm run smoke:production',
  ]);

  // The opt-in Railway preview deploys only to the `preview` environment with an environment-scoped
  // project token that reaches one step, never runs PR code on the runner, and never touches
  // production configuration. Only real /preview requests join the single deploy slot.
  const previewSource = read('.github/workflows/railway-preview.yml');
  const preview = workflow(parse(previewSource));
  assert.deepEqual(Object.keys(preview.on), ['issue_comment', 'workflow_dispatch']);
  assert.deepEqual(preview.on['issue_comment']?.types, ['created']);
  assert.deepEqual(preview.permissions, { contents: 'read', 'pull-requests': 'write' });
  assert.equal(preview.concurrency, undefined, 'skipped comment runs must not join the slot');
  assert.deepEqual(Object.keys(preview.jobs), ['resolve', 'preview']);
  const previewResolve = requiredJob(preview, 'resolve');
  const previewJob = requiredJob(preview, 'preview');
  assert.match(
    requiredString(previewResolve.if),
    /^\(github\.run_attempt == 1 \|\| github\.triggering_actor == github\.repository_owner\) &&/u,
    'a re-run re-resolves the PR head, so only the owner may re-run'
  );
  assert.match(
    requiredString(previewResolve.if),
    /github\.event_name == 'workflow_dispatch' && github\.actor == github\.repository_owner/u
  );
  assert.match(requiredString(previewResolve.if), /github\.event\.comment\.user\.type == 'User'/u);
  assert.match(requiredString(previewResolve.if), /author_association == 'OWNER'/u);
  assert.match(requiredString(previewResolve.if), /author_association == 'MEMBER'/u);
  assert.match(requiredString(previewResolve.if), /author_association == 'COLLABORATOR'/u);
  assert.doesNotMatch(requiredString(previewResolve.if), /CONTRIBUTOR/u);
  assert.equal(previewResolve.env['COMMENT_AUTHOR'], `\${{ github.event.comment.user.login }}`);
  assert.doesNotMatch(requiredString(requiredStep(previewResolve.steps, 1).run), /\$\{\{/u);
  assert.equal(previewResolve.environment, undefined);
  assert.doesNotMatch(JSON.stringify(previewResolve), /secrets\./u);
  assert.deepEqual(
    previewResolve.steps.filter((step) => step.uses).map((step) => [step.uses, step.with]),
    [['actions/checkout@v7', { 'persist-credentials': false }]]
  );
  assert.match(
    requiredString(requiredStep(previewResolve.steps, 1).run),
    /\| bash scripts\/vercel-preview-comment\.sh/u
  );
  assert.match(
    requiredString(requiredStep(previewResolve.steps, 1).run),
    /head_repo" != "\$REPO"/u
  );
  assert.equal(previewJob.needs, 'resolve');
  assert.equal(
    previewJob.if,
    `\${{ (github.run_attempt == 1 || github.triggering_actor == github.repository_owner) && needs.resolve.outputs.skip == 'false' }}`,
    "a re-run of the deploy job alone is the owner's too"
  );
  assert.equal(
    requiredStep(previewResolve.steps, previewResolve.steps.length - 1).if,
    `\${{ (failure() || cancelled()) && steps.pr.outputs.pr_number != '' }}`
  );
  assert.equal(previewJob.environment, 'railway-preview');
  assert.deepEqual(previewJob.concurrency, {
    group: 'railway-preview',
    'cancel-in-progress': false,
  });
  const rawPreviewJob = record(record(record(parse(previewSource))['jobs'])['preview']);
  assert.ok(rawPreviewJob['env'] !== undefined);
  assert.doesNotMatch(JSON.stringify(previewJob.env), /secrets\./u);
  assert.deepEqual(
    previewJob.steps.map((step) => step.uses ?? step.name),
    [
      'actions/setup-node@v6',
      'actions/checkout@v7',
      'Deploy the PR head to the Railway preview environment',
      'Report a failed preview deploy',
    ]
  );
  const [previewNode, previewCheckout, previewDeploy, previewReport] = previewJob.steps;
  assert.ok(previewNode && previewCheckout && previewDeploy && previewReport);
  assert.deepEqual(previewNode.with, { 'node-version': 26, 'package-manager-cache': false });
  assert.deepEqual(previewCheckout.with, {
    ref: `\${{ needs.resolve.outputs.head_sha }}`,
    'persist-credentials': false,
  });
  assert.equal(previewDeploy.env['RAILWAY_TOKEN'], `\${{ secrets.RAILWAY_TOKEN }}`);
  assert.equal(previewReport.if, `\${{ failure() || cancelled() }}`);
  assert.doesNotMatch(JSON.stringify(previewReport), /secrets\.|RAILWAY_/u);
  const previewRun = requiredString(previewDeploy.run);
  assert.doesNotMatch(
    previewRun,
    /npm (?:ci|install|run)\b|npx |\b(?:node|tsx|sh|bash|source|make) |(?:^|\s)\.\/|scripts\//mu,
    'the token-bearing step executes nothing from the PR tree'
  );
  assert.deepEqual(previewRun.match(/\brailway [a-z]+/gu), ['railway up']);
  assert.match(
    previewRun,
    /cd "\$RUNNER_TEMP"\n\s+timeout 900 npm exec --yes --package=@railway\/cli@5\.50\.2 -- \\\n\s+railway up /u
  );
  assert.deepEqual(previewRun.match(/(?:--environment|-e) \S+/gu), ['--environment preview']);
  const upload = previewRun.indexOf('railway up ');
  for (const [guard, reason] of [
    ['[[ "$(git rev-parse HEAD)" != "$HEAD_SHA" ]]', 'upload only the resolved head'],
    ['find "$GITHUB_WORKSPACE" -type l -print -quit', 'refuse symlinks before uploading'],
    ['rm -rf "$GITHUB_WORKSPACE/.railway"', 'the production IaC never travels with a preview'],
    [
      `printf '%s\\n' "$HEAD_SHA" >"$GITHUB_WORKSPACE/public/preview-release.txt"`,
      'stamp the uploaded commit',
    ],
  ]) {
    assert.ok(guard !== undefined && reason !== undefined);
    const index = previewRun.indexOf(guard);
    assert.ok(index >= 0 && index < upload, reason);
  }
  assert.match(previewRun, /"\$\{origin\}\/preview-release\.txt"/u);
  assert.match(previewRun, /\[\[ "\$served" == "\$HEAD_SHA" \]\]/u);
  assert.doesNotMatch(previewSource, /config apply|--include-variables|94d3de2f/u);

  // Execute the actual preview shell with isolated provider boundaries. Advancing
  // Bash's clock at its polling sleep exercises the real timeout without waiting.
  const previewFixture = mkdtempSync(join(realpathSync(tmpdir()), 'georoids-preview-workflow-'));
  try {
    const requestedSha = 'a'.repeat(40);
    const cli = `#!${process.execPath}\n${read('scripts/fixtures/preview-workflow-command.ts')}`;
    const runPreview = (name: string, overrides: PreviewOptions = {}) => {
      const directory = join(previewFixture, name);
      const workspace = join(directory, 'workspace');
      const bin = join(directory, 'bin');
      const temporary = join(directory, 'runner');
      for (const path of [bin, temporary, join(workspace, 'public'), join(workspace, '.railway')]) {
        mkdirSync(path, { recursive: true });
      }
      mkdirSync(join(workspace, 'scripts'));
      writeFileSync(
        join(workspace, 'scripts/vercel-preview-comment.sh'),
        read('scripts/vercel-preview-comment.sh')
      );
      writeFileSync(join(workspace, '.railway/production.txt'), 'must not upload');
      if (overrides.symlink === true) {
        symlinkSync(join(temporary, 'outside'), join(workspace, 'link'));
      }
      const commandSource = join(directory, 'command.ts');
      writeFileSync(commandSource, cli, { mode: 0o755 });
      for (const command of ['gh', 'jq', 'git', 'timeout', 'npm', 'curl', 'sleep']) {
        symlinkSync(commandSource, join(bin, command));
      }
      const clock = join(directory, 'clock.sh');
      writeFileSync(
        clock,
        `trap 'if [[ "$BASH_COMMAND" == "sleep 10" ]]; then SECONDS=$((SECONDS + 901)); fi' DEBUG\n`
      );
      const callsFile = join(directory, 'calls.jsonl');
      const output = join(directory, 'outputs');
      writeFileSync(callsFile, '');
      writeFileSync(output, '');
      const pr = {
        state: overrides.closed === true ? 'closed' : 'open',
        head: {
          sha: overrides.badHead === true ? 'main' : requestedSha,
          ref: 'codex/preview-test',
          repo: { full_name: overrides.fork === true ? 'other/GeoRoids' : 'jsolly/GeoRoids' },
        },
      };
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        PATH: `${bin}:${process.env['PATH']}`,
        BASH_ENV: clock,
        GH_TOKEN: 'fixture',
        RAILWAY_TOKEN: 'fixture',
        REPO: 'jsolly/GeoRoids',
        RUN_URL: 'https://github.com/jsolly/GeoRoids/actions/runs/1',
        EVENT_NAME: overrides.comment === undefined ? 'workflow_dispatch' : 'issue_comment',
        COMMENT_BODY: overrides.comment ?? '',
        COMMENT_AUTHOR: overrides.author ?? 'solly-agent',
        ISSUE_NUMBER: '814',
        DISPATCH_PR: '814',
        RUNNER_TEMP: temporary,
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: output,
        PR_NUMBER: '814',
        HEAD_SHA: requestedSha,
        HEAD_REF: pr.head.ref,
        RAILWAY_PROJECT_ID: previewDeploy.env['RAILWAY_PROJECT_ID'],
        RAILWAY_SERVICE_ID: previewDeploy.env['RAILWAY_SERVICE_ID'],
        RAILWAY_PREVIEW_DOMAIN: 'georoids-preview-9313.up.railway.app',
        FIXTURE_CALLS: callsFile,
        FIXTURE_PR: JSON.stringify(pr),
        FIXTURE_CHECKOUT_SHA: overrides.mismatch === true ? 'b'.repeat(40) : requestedSha,
        FIXTURE_SERVED_SHA: overrides.stale === true ? 'c'.repeat(40) : requestedSha,
        FIXTURE_API_FAIL: overrides.apiFailure === true ? '1' : '0',
        FIXTURE_PERMISSION: overrides.permission ?? 'write',
        FIXTURE_PERMISSION_FAIL: overrides.permissionFailure === true ? '1' : '0',
        FIXTURE_UPLOAD_FAIL: overrides.uploadFailure === true ? '1' : '0',
        FIXTURE_HEALTH_FAIL: overrides.healthFailure === true ? '1' : '0',
        FIXTURE_HTML_FAIL: overrides.htmlFailure === true ? '1' : '0',
      };
      const execute = (source: string) =>
        spawnSync('bash', ['-c', source], {
          cwd: workspace,
          env,
          encoding: 'utf8',
          timeout: 10000,
        });
      const resolveStep = previewResolve.steps.find((step) => step.id === 'pr');
      assert.ok(resolveStep);
      const resolve = execute(requiredString(resolveStep.run));
      assert.equal(resolve.error, undefined, `${name}: resolve fixture failed to execute`);
      const resolved = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('='))
      );
      let deploy: SpawnSyncReturns<string> | undefined;
      if (resolve.status === 0 && resolved.skip === 'false') {
        assert.equal(resolved.head_sha, requestedSha);
        deploy = execute(previewRun);
        assert.equal(deploy.error, undefined, `${name}: deploy fixture failed to execute`);
        if (deploy.status !== 0) {
          assert.equal(execute(requiredString(previewReport.run)).status, 0);
        }
      } else if (resolve.status !== 0) {
        assert.equal(
          execute(
            requiredString(requiredStep(previewResolve.steps, previewResolve.steps.length - 1).run)
          ).status,
          0
        );
      }
      const calls = readFileSync(callsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(fixtureCall);
      return { resolve, resolved, deploy, calls, workspace, temporary };
    };
    const failureCases: [string, PreviewOptions, number][] = [
      ['unreadable-pr', { apiFailure: true }, 0],
      ['fork', { fork: true }, 0],
      ['closed-pr', { closed: true }, 0],
      ['wrong-checkout', { mismatch: true }, 0],
      ['symlink', { symlink: true }, 0],
      ['failed-upload', { uploadFailure: true }, 1],
      ['stale-deployment', { stale: true }, 1],
      ['unhealthy-deployment', { healthFailure: true }, 1],
      ['missing-client', { htmlFailure: true }, 1],
    ];
    for (const [name, options, uploads] of failureCases) {
      const result = runPreview(name, options);
      assert.notEqual(result.deploy?.status ?? result.resolve.status, 0, `${name} must reject`);
      assert.equal(
        result.calls.filter((call) => call.command === 'npm').length,
        uploads,
        `${name}: upload admission`
      );
      const comments = result.calls.filter(
        (call) => call.command === 'gh' && call.args[0] === 'pr'
      );
      assert.equal(comments.length, 1, `${name}: report the failure`);
      assert.doesNotMatch(
        requiredString(at(comments, 0).args.at(-1)),
        /^Preview for /u,
        `${name}: never report success`
      );
    }
    for (const permission of ['write', 'admin']) {
      const result = runPreview(`comment-${permission}`, { comment: '/preview', permission });
      assert.equal(result.resolve.status, 0, result.resolve.stderr);
      assert.ok(result.deploy);
      assert.equal(result.deploy.status, 0, result.deploy.stderr);
      assert.equal(
        at(result.calls, 0).args[3],
        'repos/jsolly/GeoRoids/collaborators/solly-agent/permission'
      );
      assert.equal(at(result.calls, 1).args[1], 'repos/jsolly/GeoRoids/pulls/814');
    }
    const deniedCases: [string, PreviewOptions][] = [
      ...['read', 'triage', 'none', '', 'null', '{"permission":"write"}', 'write\nadmin'].map(
        (permission, index): [string, PreviewOptions] => [
          `denied-permission-${index}`,
          { permission },
        ]
      ),
      ['permission-api-error', { permissionFailure: true }],
      ['invalid-author', { author: '../solly-agent' }],
      ['comment-fork', { fork: true }],
      ['comment-closed', { closed: true }],
      ['comment-bad-head', { badHead: true }],
    ];
    for (const [name, options] of deniedCases) {
      const result = runPreview(name, { comment: '/preview', ...options });
      assert.notEqual(result.resolve.status, 0, `${name} must reject`);
      assert.equal(result.resolved.skip, undefined, `${name} must not authorize deployment`);
      assert.equal(result.resolved.head_sha, undefined, `${name} must not release a head`);
      assert.equal(result.deploy, undefined, `${name} must not start the secret-bearing job`);
      assert.equal(
        result.calls.some((call) => call.command === 'npm'),
        false
      );
    }
    for (const [index, comment] of [
      'please /preview',
      '/preview now',
      '/preview-extra',
      'quoted\n/preview',
    ].entries()) {
      const result = runPreview(`non-request-${index}`, { comment });
      assert.equal(result.resolve.status, 0, result.resolve.stderr);
      assert.equal(result.resolved.skip, 'true');
      assert.equal(result.deploy, undefined);
      assert.deepEqual(result.calls, [], 'non-requests must not reach GitHub or Railway');
    }
    const success = runPreview('matching-deployment');
    assert.ok(success.deploy);
    assert.equal(success.deploy.status, 0, success.deploy.stderr);
    const uploads = success.calls.filter((call) => call.command === 'npm');
    assert.equal(uploads.length, 1);
    assert.deepEqual(at(uploads, 0).args, [
      'exec',
      '--yes',
      '--package=@railway/cli@5.50.2',
      '--',
      'railway',
      'up',
      success.workspace,
      '--path-as-root',
      '--ci',
      '--project',
      previewDeploy.env['RAILWAY_PROJECT_ID'],
      '--service',
      previewDeploy.env['RAILWAY_SERVICE_ID'],
      '--environment',
      'preview',
      '--message',
      `preview PR 814 codex/preview-test ${requestedSha}`,
    ]);
    const comments = success.calls.filter((call) => call.command === 'gh' && call.args[0] === 'pr');
    assert.equal(comments.length, 1);
    assert.match(
      requiredString(at(comments, 0).args.at(-1)),
      new RegExp(`^Preview for .*${requestedSha}`, 'u')
    );
  } finally {
    rmSync(previewFixture, { recursive: true, force: true });
  }

  // Execute the actual integration pipeline with coded runner/tee/receipt outcomes.
  // No app service or gameplay workload is started by these shell fixtures.
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-ci-pipeline-'));
  try {
    mkdirSync(join(fixture, 'scripts'));
    mkdirSync(join(fixture, 'bin'));
    mkdirSync(join(fixture, '.performance/ci-code-integration'), { recursive: true });
    writeFileSync(
      join(fixture, 'scripts/test-runner.sh'),
      '#!/bin/sh\nprintf "coded integration output\\n"\nexit "$CODED_RUNNER_EXIT"\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(fixture, 'bin/tee'),
      '#!/bin/sh\ncat > "$1"\ncat "$1"\nexit "$CODED_TEE_EXIT"\n',
      { mode: 0o755 }
    );
    const called = join(fixture, 'receipt-called');
    writeFileSync(
      join(fixture, 'bin/node'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CODED_RECEIPT_CALLED"\nexit "$CODED_RECEIPT_EXIT"\n',
      { mode: 0o755 }
    );
    for (const runnerExit of [0, 7]) {
      for (const teeExit of [0, 8]) {
        for (const receiptExit of [0, 9]) {
          rmSync(called, { force: true });
          const result: SpawnSyncReturns<string> = spawnSync(
            'bash',
            ['-c', requiredString(integration.run)],
            {
              cwd: fixture,
              env: {
                ...process.env,
                PATH: `${join(fixture, 'bin')}:${process.env['PATH']}`,
                CODED_RUNNER_EXIT: String(runnerExit),
                CODED_TEE_EXIT: String(teeExit),
                CODED_RECEIPT_EXIT: String(receiptExit),
                CODED_RECEIPT_CALLED: called,
                GEOROIDS_CODE_INTEGRATION_RECEIPT: join(
                  fixture,
                  '.performance/ci-code-integration/runner.json'
                ),
              },
              encoding: 'utf8',
            }
          );
          assert.equal(result.error, undefined);
          assert.equal(result.status === 0, runnerExit === 0 && teeExit === 0 && receiptExit === 0);
          if (runnerExit === 0 && teeExit === 0) {
            assert.match(readFileSync(called, 'utf8'), /validateCodeIntegrationReceipt/u);
          } else {
            assert.equal(existsSync(called), false);
          }
        }
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  // The media lane verifies the committed baseline. Only after that check fails does it render a
  // candidate outside the checkout and upload it for review; CI never writes the committed assets.
  assert.equal(manifest.scripts['wiki:media:check'], 'tsx scripts/wiki-media.ts --verify');
  assert.equal(manifest.scripts['wiki:media'], 'tsx scripts/wiki-media.ts');
  const mediaSteps = requiredJob(ci, 'wiki-media').steps;
  assert.deepEqual(
    mediaSteps.filter((step) => /^npm run /u.test(step.run ?? '')).map((step) => step.run),
    commandsByLane['wiki-media']
  );
  const mediaCheck = mediaSteps.find((step) => step.run === 'npm run wiki:media:check');
  assert.ok(mediaCheck);
  assert.equal(mediaCheck.id, 'wiki-media');
  assert.equal(mediaCheck.if, "steps.verified-tree.outputs.run_full != 'false'");
  const mediaCandidate = mediaSteps.filter(
    (step) => step.if === "failure() && steps.wiki-media.outcome == 'failure'"
  );
  assert.deepEqual(
    mediaCandidate.map((step) => step.run ?? step.uses),
    ['npm run wiki:media -- --output "$RUNNER_TEMP/wiki-media-baseline"', uploadArtifactAction]
  );
  assert.equal(at(mediaCandidate, 1).with['path'], `\${{ runner.temp }}/wiki-media-baseline`);

  // Execute the actual aggregate step for all 4096 GitHub dependency outcomes.
  const aggregate = required.steps.find(
    (step) => step.name === 'Require all six validation lanes to pass'
  );
  assert.ok(aggregate);
  const laneResults = {
    STATIC_RESULT: 'static-checks',
    RUNNER_RESULT: 'runner-contracts',
    ACTIONS_RESULT: 'actions-contracts',
    INTEGRATION_RESULT: 'integration-tests',
    WIKI_MEDIA_RESULT: 'wiki-media',
    RAILPACK_RESULT: 'railpack-build',
  };
  for (const [variable, lane] of Object.entries(laneResults)) {
    assert.equal(aggregate.env[variable], `\${{ needs.${lane}.result }}`);
  }
  const outcomes = ['success', 'failure', 'cancelled', 'skipped'];
  const combinations = Object.keys(laneResults).reduce<Record<string, string>[]>(
    (rows, variable) =>
      rows.flatMap((row) => outcomes.map((outcome) => ({ ...row, [variable]: outcome }))),
    [{}]
  );
  assert.equal(combinations.length, 4096);
  for (const results of combinations) {
    const result: SpawnSyncReturns<string> = spawnSync(
      'bash',
      ['-c', requiredString(aggregate.run)],
      {
        env: { ...process.env, ...results },
        encoding: 'utf8',
      }
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.status === 0,
      Object.values(results).every((outcome) => outcome === 'success')
    );
  }

  process.stdout.write(
    'CI contracts passed: six parallel lanes, exact command coverage, fail-closed aggregation, mandatory local tests, and failure propagation.\n'
  );
});
