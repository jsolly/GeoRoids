import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const ci = parse(read('.github/workflows/ci.yml'));
const coverage = parse(read('.github/workflows/coverage.yml'));
const required = ci.jobs.ci;
assert.deepEqual(required.needs, ['static-checks', 'runner-contracts', 'behavioral-smoke']);
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

// Execute the actual aggregate step for all 64 GitHub dependency outcomes.
const aggregate = required.steps.find(
  (step) => step.name === 'Require all three validation lanes to pass'
);
assert.ok(aggregate);
assert.equal(aggregate.env.STATIC_RESULT, `\${{ needs.static-checks.result }}`);
assert.equal(aggregate.env.RUNNER_RESULT, `\${{ needs.runner-contracts.result }}`);
assert.equal(aggregate.env.BEHAVIORAL_RESULT, `\${{ needs.behavioral-smoke.result }}`);
const outcomes = ['success', 'failure', 'cancelled', 'skipped'];
for (const staticResult of outcomes) {
  for (const runnerResult of outcomes) {
    for (const behavioralResult of outcomes) {
      const result = spawnSync('bash', ['-c', aggregate.run], {
        env: {
          ...process.env,
          STATIC_RESULT: staticResult,
          RUNNER_RESULT: runnerResult,
          BEHAVIORAL_RESULT: behavioralResult,
        },
        encoding: 'utf8',
      });
      assert.equal(result.error, undefined);
      assert.equal(
        result.status === 0,
        staticResult === 'success' && runnerResult === 'success' && behavioralResult === 'success'
      );
    }
  }
}

process.stdout.write(
  'CI contracts passed: three parallel lanes, exact command coverage, fail-closed aggregation, mandatory local tests, and failure propagation.\n'
);
