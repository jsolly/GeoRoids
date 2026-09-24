import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
assert.deepEqual(Object.keys(coverage.on), ['workflow_dispatch']);
assert.equal(
  JSON.parse(read('package.json')).scripts.gate,
  'FLEET_DOC_FAST=0 bash .git-hooks/pre-commit && npm run test:review'
);
assert.match(read('.git-hooks/pre-commit'), /run_step .* npm test/u);
assert.equal(
  JSON.parse(read('package.json')).scripts['test:review'],
  'bash scripts/test-review.sh'
);

// Execute the actual aggregate step for every GitHub dependency outcome.
const aggregate = required.steps.find((step) => step.run);
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

// Exercise the real local script with cheap stage substitutes. A failed stage
// or tee must stop the sequence, retain diagnostics, and return failure.
const fixture = mkdtempSync(join(tmpdir(), 'georoids-review-contract-'));
try {
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'bin'));
  copyFileSync(new URL('scripts/test-review.sh', root), join(fixture, 'scripts/test-review.sh'));
  const substitute = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *tests/integration/*) stage=integration ;;
  *measure-frame-work*) stage=frame ;;
  *traversal*) stage=traversal ;;
  *combat*) stage=combat ;;
  *) exit 64 ;;
esac
echo "$stage" >> "$CALLS"
echo "$stage output"
mkdir -p logs
echo "$stage server log" > logs/server.log
if [[ "$stage" == "$FAIL_STAGE" ]]; then exit 42; fi
`;
  for (const path of ['scripts/test-runner.sh', 'bin/node']) {
    writeFileSync(join(fixture, path), substitute, { mode: 0o755 });
  }
  const stages = ['integration', 'frame', 'traversal', 'combat'];
  for (const failure of ['', ...stages, 'tee']) {
    const calls = join(fixture, 'calls');
    writeFileSync(calls, '');
    if (failure === 'tee') {
      writeFileSync(join(fixture, 'bin/tee'), '#!/usr/bin/env bash\ncat >/dev/null\nexit 43\n', {
        mode: 0o755,
      });
    }
    const result = spawnSync('bash', ['scripts/test-review.sh'], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${join(fixture, 'bin')}:${process.env.PATH}`,
        CALLS: calls,
        FAIL_STAGE: failure,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status === 0, failure === '', result.stdout + result.stderr);
    const expected =
      failure === 'tee'
        ? ['integration']
        : stages.slice(0, failure ? stages.indexOf(failure) + 1 : stages.length);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), expected);
    const runs = readdirSync(join(fixture, '.performance/review'));
    assert.ok(runs.length > 0);
    const outputPath = result.stdout.match(/Review artifacts: (.+)/u)?.[1];
    assert.ok(outputPath);
    assert.match(
      readFileSync(join(outputPath, 'result.txt'), 'utf8'),
      failure ? /exit_status=[1-9]/u : /exit_status=0/u
    );
    for (const stage of expected) {
      assert.equal(
        readFileSync(join(outputPath, stage, 'logs/server.log'), 'utf8').trim(),
        `${stage} server log`
      );
    }
    if (failure !== 'tee') {
      assert.match(
        readFileSync(join(outputPath, 'integration/output.log'), 'utf8'),
        /integration output/u
      );
    }
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
process.stdout.write(
  'CI contracts passed: parallel lanes, fail-closed aggregation, mandatory local tests, and failure propagation.\n'
);
