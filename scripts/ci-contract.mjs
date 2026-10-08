import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const ci = parse(read('.github/workflows/ci.yml'));
const coverage = parse(read('.github/workflows/coverage.yml'));
const required = ci.jobs.ci;
assert.deepEqual(required.needs, ['static-checks', 'runner-contracts', 'integration-tests']);
assert.match(required.if, /always\(\)/u);
for (const name of required.needs) {
  assert.equal(
    ci.jobs[name].needs,
    undefined,
    `${name} must start without waiting for another lane`
  );
  assert.ok(ci.jobs[name]['timeout-minutes'] <= 4);
  assert.equal(ci.jobs[name]['runs-on'], 'ubuntu-24.04-arm');
  assert.equal(ci.jobs[name].if, ci.jobs['static-checks'].if);
  assert.equal(ci.jobs[name].name, ci.jobs['static-checks'].name.replaceAll('static-checks', name));
}
// Secrets scan precedes reusable-tree decisions in each independently validated lane.
for (const name of required.needs) {
  const steps = ci.jobs[name].steps;
  assert.equal(steps[0].uses, 'actions/checkout@v7');
  assert.equal(steps[0].with['fetch-depth'], 0);
  assert.equal(steps[0].with['persist-credentials'], false);
  assert.equal(steps[1].name, 'Secrets scan (range)');
  assert.equal(steps[1].if, undefined);
  assert.match(steps[1].run, /sha256sum --check/u);
  assert.match(steps[1].run, /--text/u);
  assert.match(steps[1].run, /--diff-merges=remerge/u);
  assert.equal(steps[1].run, ci.jobs['static-checks'].steps[1].run);
  assert.equal(steps[2].id, 'verified-tree');
  assert.equal(steps[2].run, 'bash scripts/ci-verified-tree.sh');
  const proof = steps.find((step) => step.name === 'Record validated PR tree');
  assert.ok(proof);
  assert.equal(
    proof.with.name,
    `ci-tree-v1-\${{ github.job }}-\${{ steps.verified-tree.outputs.tree }}-\${{ github.run_attempt }}`
  );
  assert.equal(proof.with.path, `\${{ runner.temp }}/ci-tree-\${{ github.job }}.txt`);
  assert.match(proof.if, /success\(\)/u);
}
assert.deepEqual(Object.keys(coverage.on), ['workflow_dispatch']);
assert.equal(
  JSON.parse(read('package.json')).scripts.gate,
  'FLEET_DOC_FAST=0 bash .git-hooks/pre-commit'
);
const hook = read('.git-hooks/pre-commit');
assert.match(hook, /^node scripts\/gate\.mjs$/mu);
assert.doesNotMatch(hook, /run_step\s+"complete gate"/u);
assert.doesNotMatch(read('scripts/gate.mjs'), /pre-commit|npm.*gate/u);
assert.equal(
  JSON.parse(read('package.json')).scripts['test:review'],
  'bash scripts/test-review.sh'
);

// Moving a check between lanes must neither remove nor duplicate a validation.
const originalStaticCommands = [
  'npm run check:actions',
  'npm run check:lint-policy',
  'npm run check:lint',
  'npm run check:knip',
  'npm run check:ts-prune',
  'npm run check:md',
  'npm run check:yaml',
  'npm run check:ts',
  'npm run check:benchmarks',
  'npm run check:test-runner',
  'npm run check:dev-server',
  'npm run build',
];
const commands = ['static-checks', 'runner-contracts'].flatMap((name) =>
  ci.jobs[name].steps.filter((step) => /^npm run /u.test(step.run ?? '')).map((step) => step.run)
);
assert.deepEqual([...commands].sort(), [...originalStaticCommands].sort());
assert.equal(new Set(commands).size, originalStaticCommands.length);
assert.deepEqual(
  ci.jobs['static-checks'].steps
    .filter((step) => /^npm run /u.test(step.run ?? ''))
    .map((step) => step.run),
  originalStaticCommands.filter(
    (command) => !['npm run check:test-runner', 'npm run check:dev-server'].includes(command)
  )
);
assert.deepEqual(
  ci.jobs['runner-contracts'].steps
    .filter((step) => /^npm run /u.test(step.run ?? ''))
    .map((step) => step.run),
  ['npm run check:test-runner', 'npm run check:dev-server']
);

// The replacement lane executes the complete default code inventory and binds
// retained reports to its source/runtime/cleanup receipt before it can pass.
const integrationSteps = ci.jobs['integration-tests'].steps;
const integration = integrationSteps.find(
  (step) => step.name === 'Run complete code integration inventory'
);
assert.ok(integration);
assert.equal(integration.if, "steps.verified-tree.outputs.run_full != 'false'");
assert.equal(
  integration.env.GEOROIDS_CODE_INTEGRATION_RECEIPT,
  `\${{ github.workspace }}/.performance/ci-code-integration/runner.json`
);
assert.match(
  integration.run,
  /GEOROIDS_TEST_MAX_DURATION_SECONDS=150 \.\/scripts\/test-runner\.sh \\\n\s+--reporter=verbose 2>&1 \| tee \.performance\/ci-code-integration\/test-run\.log/u
);
assert.match(
  integration.run,
  /validateCodeIntegrationReceipt\(process\.env\.GEOROIDS_CODE_INTEGRATION_RECEIPT\)/u
);
assert.doesNotMatch(integration.run, /tests\/integration\/|--exclude|--shard|testNamePattern/u);
const integrationUpload = integrationSteps.find(
  (step) => step.name === 'Upload code integration artifacts'
);
assert.equal(integrationUpload.with.path, '.performance/ci-code-integration');
assert.equal(integrationUpload.with['include-hidden-files'], true);
assert.equal(integrationUpload.with['if-no-files-found'], 'error');
assert.match(integrationUpload.if, /always\(\)/u);
for (const job of Object.values(ci.jobs)) {
  for (const step of job.steps) {
    assert.doesNotMatch(
      step.run ?? '',
      /playwright install|chromium|webkit|tests\/integration\/browser/u
    );
  }
}
const manifest = JSON.parse(read('package.json'));
// Manual measurements are explicit user entrypoints, never hidden validation.
const browserMeasurement =
  /playwright|puppeteer|--benchmark-(?:client|load)|benchmark:(?:realtime|load)|measure-frame-work|wiki:media/u;
for (const [name, command] of Object.entries(manifest.scripts)) {
  if (/^(?:test(?::|$)|check:|gate$|fix$)/u.test(name)) {
    assert.doesNotMatch(command, browserMeasurement, `${name} must remain code-only validation`);
  }
}
for (const file of ['.github/workflows/ci.yml', '.github/workflows/production-smoke.yml']) {
  const workflow = parse(read(file));
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(
        step.run ?? '',
        browserMeasurement,
        `${file} must not invoke manual measurements`
      );
    }
  }
}
assert.equal(manifest.scripts['test:integration'], './scripts/test-runner.sh --reporter=verbose');
assert.equal(manifest.scripts['test:all'], 'npm run test && npm run test:integration');
assert.equal(
  manifest.scripts['check:test-runner'],
  "node scripts/validation-admission.mjs contracts -- bash -c 'bash scripts/test-runner-contract.sh && node --test scripts/test-ports.test.mjs scripts/validation-admission.test.mjs'"
);
assert.match(
  read('scripts/test-runner-contract.sh'),
  /exec node --test scripts\/code-integration-runner\.test\.mjs scripts\/benchmark-runner\.test\.mjs/u
);
assert.equal(
  manifest.scripts['check:actions'],
  'node --import tsx --test scripts/server-release-inputs.test.mjs scripts/production-smoke-scenario.test.mjs && node scripts/ci-contract.mjs && node --test scripts/gate-contract.test.mjs && node scripts/review-receipt-contract.mjs && bash scripts/check-actions.sh'
);
assert.equal(
  manifest.scripts['smoke:production'],
  'node --import tsx scripts/production-smoke-entry.mjs'
);
assert.equal(
  manifest.scripts['smoke:scenario-contract'],
  'node --import tsx --test scripts/server-release-inputs.test.mjs scripts/production-smoke-scenario.test.mjs'
);
assert.ok(manifest.devDependencies.playwright, 'Manual benchmarks and media still need Playwright');
assert.equal(manifest.scripts['benchmark:realtime'], './scripts/test-runner.sh --benchmark-client');
assert.equal(manifest.scripts['benchmark:load'], './scripts/test-runner.sh --benchmark-load');
for (const command of Object.keys(manifest.scripts)) {
  assert.doesNotMatch(command, /^test:integration:(?:browser|sharded)/u);
}
const production = parse(read('.github/workflows/production-smoke.yml'));
assert.doesNotMatch(
  read('.github/workflows/production-smoke.yml'),
  /playwright install|chromium|webkit/u
);
const productionCommands = production.jobs.smoke.steps.map((step) => step.run).filter(Boolean);
assert.deepEqual(productionCommands, [
  'npm ci',
  'npm run smoke:scenario-contract',
  'npm run smoke:production',
]);

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
        const result = spawnSync('bash', ['-c', integration.run], {
          cwd: fixture,
          env: {
            ...process.env,
            PATH: `${join(fixture, 'bin')}:${process.env.PATH}`,
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
        });
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

// Execute the actual aggregate step for all 64 GitHub dependency outcomes.
const aggregate = required.steps.find(
  (step) => step.name === 'Require all three validation lanes to pass'
);
assert.ok(aggregate);
assert.equal(aggregate.env.STATIC_RESULT, `\${{ needs.static-checks.result }}`);
assert.equal(aggregate.env.RUNNER_RESULT, `\${{ needs.runner-contracts.result }}`);
assert.equal(aggregate.env.INTEGRATION_RESULT, `\${{ needs.integration-tests.result }}`);
const outcomes = ['success', 'failure', 'cancelled', 'skipped'];
for (const staticResult of outcomes) {
  for (const runnerResult of outcomes) {
    for (const integrationResult of outcomes) {
      const result = spawnSync('bash', ['-c', aggregate.run], {
        env: {
          ...process.env,
          STATIC_RESULT: staticResult,
          RUNNER_RESULT: runnerResult,
          INTEGRATION_RESULT: integrationResult,
        },
        encoding: 'utf8',
      });
      assert.equal(result.error, undefined);
      assert.equal(
        result.status === 0,
        staticResult === 'success' && runnerResult === 'success' && integrationResult === 'success'
      );
    }
  }
}

process.stdout.write(
  'CI contracts passed: three parallel lanes, exact command coverage, fail-closed aggregation, mandatory local tests, and failure propagation.\n'
);
