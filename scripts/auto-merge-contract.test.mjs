import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'vitest';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const workflowPath = '.github/workflows/auto-merge.yml';
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const workflow = parse(read(workflowPath));
const source = read(workflowPath);
const script = workflow.jobs['auto-merge'].steps[0].run;
const repo = 'jsolly/GeoRoids';
const sha = 'a'.repeat(40);

function prLine({
  state = 'open',
  draft = 'false',
  login = 'jsolly',
  head = repo,
  base = repo,
  headSha = sha,
  armed = 'false',
  number = '12',
} = {}) {
  return [
    state,
    draft,
    login,
    head,
    base,
    headSha,
    armed,
    `https://github.com/${repo}/pull/${number}`,
  ].join('\t');
}

function run(env, files) {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-auto-merge-'));
  const log = join(directory, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const dir = process.env.FIXTURE_DIR;
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
const read = (name) => {
  const path = dir + '/' + name;
  return fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
};
if (args[0] === 'api') {
  const url = args.find((arg) => arg.startsWith('repos/'));
  if (!url) {
    console.error('missing api url');
    process.exit(1);
  }
  if (url.includes('/check-runs')) {
    const code = Number((read('checks_exit') || '0').trim());
    if (code !== 0) process.exit(code);
    process.stdout.write(read('checks.tsv'));
    process.exit(0);
  }
  if (url.includes('state=open')) {
    const code = Number((read('list_exit') || '0').trim());
    if (code !== 0) process.exit(code);
    process.stdout.write(read('open-numbers.txt'));
    process.exit(0);
  }
  if (url.includes('/pulls/')) {
    const countPath = dir + '/fetch-count';
    const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
    fs.writeFileSync(countPath, String(count + 1));
    const second = read('pr-second.tsv');
    process.stdout.write(count === 0 || second.length === 0 ? read('pr.tsv') : second);
    process.exit(0);
  }
  console.error('unexpected api ' + url);
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const file = args.includes('--auto') ? 'arm' : 'direct';
  const code = Number((read(file + '_exit') || '0').trim());
  const output = read(file + '_output');
  if (code === 0) process.stdout.write(output);
  else {
    process.stderr.write(output);
    process.exit(code);
  }
  process.exit(0);
}
console.error('unexpected ' + args.join(' '));
process.exit(1);
`
  );
  spawnSync('chmod', ['755', join(directory, 'gh')]);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  const result = spawnSync('bash', ['-s'], {
    input: script,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FIXTURE_DIR: directory,
      FIXTURE_LOG: log,
      GH_TOKEN: 'test-token',
      REPO: repo,
      EVENT_NAME: 'pull_request',
      EVENT_DRAFT: 'false',
      EVENT_AUTHOR: 'jsolly',
      EVENT_HEAD_REPO: repo,
      EVENT_BASE_REPO: repo,
      PR_NUMBER: '12',
      GITHUB_STEP_SUMMARY: '',
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function merges(calls, auto) {
  return calls.filter(
    (call) => call[0] === 'pr' && call[1] === 'merge' && call.includes('--auto') === auto
  );
}

test('auto-merge workflow arms native squash merge and keeps a sweep backstop', () => {
  assert.equal(workflow.name, 'Auto-merge');
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.pull_request.types, [
    'opened',
    'reopened',
    'synchronize',
    'ready_for_review',
  ]);
  assert.deepEqual(workflow.on.schedule, [{ cron: '*/30 * * * *' }]);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /auto-merge-/u);
  assert.deepEqual(Object.keys(workflow.jobs), ['auto-merge']);
  const job = workflow.jobs['auto-merge'];
  assert.equal(job.steps.length, 1);
  assert.equal(job.steps[0].uses, undefined);
  assert.equal(job.steps[0].env.GH_TOKEN, '$' + '{{ secrets.AUTO_MERGE_TOKEN }}');
  assert.doesNotMatch(source, /github\.token|actions\/checkout|workflow run/u);
  assert.match(script, /gh pr merge --auto --squash/u);
  assert.match(script, /gh pr merge --squash --match-head-commit/u);
  assert.match(script, /select\(\.name == "ci" or \.name == "security"\)/u);
  assert.match(script, /AUTO_MERGE_TOKEN is not set/u);
  assert.match(script, /solly-agent \| jsolly \| 'cursor\[bot\]'/u);

  const armed = run({}, { 'pr.tsv': `${prLine()}\n`, arm_exit: '0', arm_output: 'enabled\n' });
  assert.equal(armed.status, 0, armed.stderr);
  assert.deepEqual(merges(armed.calls, true), [
    ['pr', 'merge', '--auto', '--squash', `https://github.com/${repo}/pull/12`],
  ]);
  assert.equal(merges(armed.calls, false).length, 0);

  for (const phrase of [
    'Auto-merge is already enabled',
    'Pull request was already merged',
    'Pull request is in clean status',
  ]) {
    const settled = run(
      {},
      {
        'pr.tsv': `${prLine()}\n`,
        arm_exit: '1',
        arm_output: `${phrase}\n`,
      }
    );
    assert.equal(settled.status, 0, `${phrase}\n${settled.stderr}`);
  }

  const refused = run(
    {},
    {
      'pr.tsv': `${prLine()}\n`,
      arm_exit: '1',
      arm_output: 'Resource not accessible\n',
    }
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /could not arm squash auto-merge for PR #12/u);

  for (const [label, env] of [
    ['draft', { EVENT_DRAFT: 'true', GH_TOKEN: '' }],
    ['dependabot', { EVENT_AUTHOR: 'dependabot[bot]', GH_TOKEN: '' }],
    ['cursor lookalike', { EVENT_AUTHOR: 'cursorb', GH_TOKEN: '' }],
    ['wrong case', { EVENT_AUTHOR: 'Jsolly', GH_TOKEN: '' }],
    ['fork', { EVENT_HEAD_REPO: 'other/GeoRoids', GH_TOKEN: '' }],
  ]) {
    const skipped = run(env, {});
    assert.equal(skipped.status, 0, label);
    assert.equal(skipped.calls.length, 0, label);
  }

  const missingToken = run({ GH_TOKEN: '' }, {});
  assert.equal(missingToken.status, 1);
  assert.match(
    missingToken.stderr,
    /AUTO_MERGE_TOKEN is not set\. Refusing to fall back to GITHUB_TOKEN\./u
  );
  assert.equal(missingToken.calls.length, 0);

  const staleDraft = run({}, { 'pr.tsv': `${prLine({ draft: 'true' })}\n` });
  assert.equal(staleDraft.status, 0, staleDraft.stderr);
  assert.equal(merges(staleDraft.calls, true).length, 0);

  const cursorBot = run(
    { EVENT_AUTHOR: 'cursor[bot]' },
    { 'pr.tsv': `${prLine({ login: 'cursor[bot]' })}\n`, arm_exit: '0', arm_output: 'enabled\n' }
  );
  assert.equal(cursorBot.status, 0, cursorBot.stderr);
  assert.deepEqual(merges(cursorBot.calls, true), [
    ['pr', 'merge', '--auto', '--squash', `https://github.com/${repo}/pull/12`],
  ]);

  const staleAuthor = run({}, { 'pr.tsv': `${prLine({ login: 'dependabot[bot]' })}\n` });
  assert.equal(staleAuthor.status, 0, staleAuthor.stderr);
  assert.equal(merges(staleAuthor.calls, true).length, 0);
});

test('auto-merge sweep re-arms and direct-merges only when ci and security are green', () => {
  const green = [
    `ci\t2026-11-10T00:00:00Z\tcompleted\tfailure`,
    `ci\t2026-11-10T01:00:00Z\tcompleted\tsuccess`,
    `security\t2026-11-10T01:00:00Z\tcompleted\tfailure`,
    `security\t2026-11-10T02:00:00Z\tcompleted\tsuccess`,
  ].join('\n');
  const sweep = run(
    { EVENT_NAME: 'schedule', PR_NUMBER: '', EVENT_AUTHOR: '', EVENT_DRAFT: '' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ number: '12' })}\n`,
      'pr-second.tsv': `${prLine({ number: '12', armed: 'true' })}\n`,
      'checks.tsv': `${green}\n`,
      arm_exit: '0',
      arm_output: 'enabled\n',
      direct_exit: '0',
      direct_output: 'merged\n',
    }
  );
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.deepEqual(merges(sweep.calls, true)[0], [
    'pr',
    'merge',
    '--auto',
    '--squash',
    `https://github.com/${repo}/pull/12`,
  ]);
  assert.deepEqual(merges(sweep.calls, false)[0], [
    'pr',
    'merge',
    '--squash',
    '--match-head-commit',
    sha,
    `https://github.com/${repo}/pull/12`,
  ]);

  const waiting = run(
    { EVENT_NAME: 'workflow_dispatch' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ armed: 'true' })}\n`,
      'checks.tsv': 'ci\t2026-11-10T01:00:00Z\tcompleted\tsuccess\n',
      direct_exit: '0',
      direct_output: 'should-not\n',
    }
  );
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.equal(merges(waiting.calls, true).length, 0);
  assert.equal(merges(waiting.calls, false).length, 0);
  assert.match(waiting.stdout, /waiting for green ci and security/u);

  const tie = run(
    { EVENT_NAME: 'schedule' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ armed: 'true' })}\n`,
      'checks.tsv': [
        'ci\t2026-11-10T01:00:00Z\tcompleted\tsuccess',
        'ci\t2026-11-10T01:00:00Z\tcompleted\tfailure',
        'security\t2026-11-10T01:00:00Z\tcompleted\tsuccess',
        '',
      ].join('\n'),
    }
  );
  assert.equal(tie.status, 0, tie.stderr);
  assert.equal(merges(tie.calls, false).length, 0);

  const newerFailure = run(
    { EVENT_NAME: 'schedule' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ armed: 'true' })}\n`,
      'checks.tsv': [
        'ci\t2026-11-10T01:00:00Z\tcompleted\tsuccess',
        'ci\t2026-11-10T02:00:00Z\tcompleted\tfailure',
        'security\t2026-11-10T02:00:00Z\tcompleted\tsuccess',
        '',
      ].join('\n'),
    }
  );
  assert.equal(newerFailure.status, 0, newerFailure.stderr);
  assert.equal(merges(newerFailure.calls, false).length, 0);

  const moved = run(
    { EVENT_NAME: 'schedule' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ armed: 'true' })}\n`,
      'checks.tsv': `${green}\n`,
      direct_exit: '1',
      direct_output: 'Head branch was modified. Review and try the merge again.\n',
    }
  );
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /Head moved before merge/u);

  const broken = run(
    { EVENT_NAME: 'schedule' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ armed: 'true' })}\n`,
      'checks.tsv': `${green}\n`,
      direct_exit: '1',
      direct_output: 'server exploded\n',
    }
  );
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /auto-merge sweep failed for PR #12/u);

  const checksDown = run(
    { EVENT_NAME: 'schedule' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ armed: 'true' })}\n`,
      checks_exit: '1',
    }
  );
  assert.equal(checksDown.status, 1);

  const emptyToken = run({ EVENT_NAME: 'schedule', GH_TOKEN: '' }, {});
  assert.equal(emptyToken.status, 1);
  assert.match(emptyToken.stderr, /AUTO_MERGE_TOKEN is not set/u);

  const none = run({ EVENT_NAME: 'schedule' }, { 'open-numbers.txt': '' });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /No open pull requests/u);

  const cursorSweep = run(
    { EVENT_NAME: 'schedule' },
    {
      'open-numbers.txt': '12\n',
      'pr.tsv': `${prLine({ login: 'cursor[bot]', armed: 'true' })}\n`,
      'checks.tsv': `${green}\n`,
      direct_exit: '0',
      direct_output: 'merged\n',
    }
  );
  assert.equal(cursorSweep.status, 0, cursorSweep.stderr);
  assert.equal(merges(cursorSweep.calls, true).length, 0);
  assert.deepEqual(merges(cursorSweep.calls, false), [
    ['pr', 'merge', '--squash', '--match-head-commit', sha, `https://github.com/${repo}/pull/12`],
  ]);

  const skippedAuthor = run(
    { EVENT_NAME: 'schedule' },
    { 'open-numbers.txt': '12\n', 'pr.tsv': `${prLine({ login: 'dependabot[bot]' })}\n` }
  );
  assert.equal(skippedAuthor.status, 0, skippedAuthor.stderr);
  assert.equal(merges(skippedAuthor.calls, true).length, 0);
  assert.equal(merges(skippedAuthor.calls, false).length, 0);
});
