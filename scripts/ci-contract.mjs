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
assert.deepEqual(required.needs, ['static-checks', 'behavioral-smoke']);
assert.match(required.if, /always\(\)/u);
for (const name of required.needs) {
  assert.equal(
    ci.jobs[name].needs,
    undefined,
    `${name} must start without waiting for another lane`
  );
  assert.ok(ci.jobs[name]['timeout-minutes'] <= 4);
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
  assert.equal(steps[2].id, 'verified-tree');
}
assert.deepEqual(Object.keys(coverage.on), ['workflow_dispatch']);
assert.equal(
  JSON.parse(read('package.json')).scripts.gate,
  'FLEET_DOC_FAST=0 bash .git-hooks/pre-commit'
);
assert.match(read('.git-hooks/pre-commit'), /run_step "complete gate" node scripts\/gate\.mjs/u);
assert.doesNotMatch(read('scripts/gate.mjs'), /pre-commit|npm.*gate/u);
assert.equal(
  JSON.parse(read('package.json')).scripts['test:review'],
  'bash scripts/test-review.sh'
);

// Execute the actual aggregate step for every GitHub dependency outcome.
const aggregate = required.steps.find(
  (step) => step.name === 'Require both validation lanes to pass'
);
assert.ok(aggregate);
assert.match(aggregate.env.STATIC_RESULT, /^\$\{\{ needs\.static-checks\.result \}\}$/u);
assert.match(aggregate.env.BEHAVIORAL_RESULT, /^\$\{\{ needs\.behavioral-smoke\.result \}\}$/u);
for (const staticResult of ['success', 'failure', 'cancelled', 'skipped']) {
  for (const behavioralResult of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = spawnSync('bash', ['-c', aggregate.run], {
      env: { ...process.env, STATIC_RESULT: staticResult, BEHAVIORAL_RESULT: behavioralResult },
      encoding: 'utf8',
    });
    assert.equal(result.status === 0, staticResult === 'success' && behavioralResult === 'success');
  }
}

process.stdout.write(
  'CI contracts passed: parallel lanes, fail-closed aggregation, mandatory local tests, and failure propagation.\n'
);
