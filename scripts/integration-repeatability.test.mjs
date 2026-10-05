import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  focusedFiles,
  fullPassWatchSeconds,
  manifests,
  parseOptions,
  readTestEvidence,
  resolveManifest,
  retainArtifacts,
  runAttempt,
  runnerDeadlineSeconds,
  samplePassed,
  summarizeAttempts,
  validateSampleOptions,
} from './integration-repeatability.mjs';

const sha = 'a'.repeat(40);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = '/tmp/native-repeatability-contract';

test('pinned samples reject malformed revisions, empty samples and excess repetitions', () => {
  const base = ['--sha', sha, '--output', output];
  assert.equal(parseOptions(base).manifest, 'current');
  assert.equal(parseOptions(base).focused, 20);
  assert.equal(parseOptions(base).full, 3);
  for (const args of [
    ['--sha', 'main', '--output', output],
    ['--sha', sha],
    [...base, '--focused', '21'],
    [...base, '--full', '4'],
    [...base, '--focused', '0', '--full', '0'],
    [...base, '--focused', '-1'],
    [...base, '--full', '1.5'],
    [...base, '--sha'],
    [...base, '--retry', '2'],
  ]) {
    assert.throws(() => parseOptions(args));
  }
});

test('a dispatch selects one reviewed manifest and may run only focused or only full attempts', () => {
  for (const name of Object.keys(manifests)) {
    assert.equal(validateSampleOptions({ manifest: name }).manifest, name);
  }
  for (const manifest of ['audio', 'historical-1', 'Current', '', 'constructor', '__proto__']) {
    assert.throws(() => validateSampleOptions({ manifest }), /Unknown manifest/u);
  }
  const crawlerOnly = ['--manifest', 'crawler', '--focused', '20', '--full', '0'];
  assert.deepEqual(parseOptions(['--sha', sha, '--output', output, ...crawlerOnly]), {
    sha,
    output,
    manifest: 'crawler',
    focused: 20,
    full: 0,
    focusedScenarios: [focusedFiles.beltCrawlers],
  });
  assert.throws(
    () => parseOptions(['--sha', sha, '--output', output, '--manifest', 'audio']),
    /Unknown manifest "audio"/u
  );
  const fullOnly = parseOptions(['--sha', sha, '--output', output, '--focused', '0']);
  assert.deepEqual(
    { focused: fullOnly.focused, full: fullOnly.full, output: fullOnly.output },
    { focused: 0, full: 3, output }
  );
  for (const counts of [
    { focused: '0', full: '0' },
    { focused: '21' },
    { full: '4' },
    { focused: '' },
    { focused: ' 5' },
    { full: '-1' },
  ]) {
    assert.throws(() => validateSampleOptions(counts), JSON.stringify(counts));
  }
});

test('a manifest naming a file without a reviewed count is rejected rather than run unpinned', () => {
  const files = { beltCrawlers: focusedFiles.beltCrawlers };
  assert.deepEqual(resolveManifest(['beltCrawlers'], files), [focusedFiles.beltCrawlers]);
  assert.throws(
    () => resolveManifest(['beltCrawlers', 'audioCoupling'], files),
    /Manifest key "audioCoupling" has no reviewed focused file/u
  );
  assert.throws(() => resolveManifest(['toString'], files), /no reviewed focused file/u);
  for (const keys of Object.values(manifests)) {
    assert.equal(resolveManifest(keys).length, keys.length);
  }
});

test('reviewed manifests pin their focused file keys and counts to tracked paths', () => {
  // Pins the reviewed values only; sample runs verify each file's real case count.
  assert.deepEqual(manifests, {
    current: [
      'titleMusic',
      'furnaceTravel',
      'resourceSound',
      'mutedSample',
      'beltCrawlers',
      'crewDelivery',
    ],
    crawler: ['beltCrawlers'],
    furnace: ['furnaceTravel'],
    'flake-classification': ['repeatedDeaths', 'beltSpiders', 'resourceSound', 'crewDelivery'],
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(focusedFiles).map(([key, { path, count }]) => [key, [path, count]])
    ),
    {
      titleMusic: [
        'tests/integration/browser/sanity/title-music-bed-loops-and-yields-to-playfield.test.ts',
        6,
      ],
      furnaceTravel: [
        'tests/integration/browser/sanity/pilots-ride-furnace-pipes-between-travel-stops.test.ts',
        7,
      ],
      resourceSound: [
        'tests/integration/browser/sanity/resource-tap-and-pickups-play-crystal-phrases.test.ts',
        2,
      ],
      mutedSample: [
        'tests/integration/browser/sanity/muted-pilot-stops-sample-after-howler-wall-clock-end.test.ts',
        3,
      ],
      beltCrawlers: [
        'tests/integration/browser/e2e/crew-mines-the-belt-and-sees-attached-crawlers.test.ts',
        4,
      ],
      crewDelivery: [
        'tests/integration/browser/e2e/crew-scan-tows-and-delivers-for-both-pilots.test.ts',
        1,
      ],
      repeatedDeaths: [
        'tests/integration/browser/e2e/pilot-keeps-playing-after-repeated-deaths.test.ts',
        1,
      ],
      beltSpiders: [
        'tests/integration/browser/e2e/belt-spiders-pursue-a-crew-across-living-rocks.test.ts',
        2,
      ],
    }
  );
  for (const keys of Object.values(manifests)) {
    assert.equal(new Set(keys).size, keys.length);
  }
  const tracked = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', ...Object.values(focusedFiles).map(({ path }) => path)],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(tracked.status, 0, tracked.stderr);
});

test('a failed attempt keeps stdout, stderr and its exit even when the next attempt passes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-repeatability-'));
  try {
    const attempts = [];
    for (const [index, code] of [42, 0].entries()) {
      const receipt = await runAttempt({
        directory: join(directory, String(index)),
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('out'); process.stderr.write('err'); process.exitCode = ${code}`,
        ],
        cwd: directory,
        env: process.env,
      });
      attempts.push({ ...receipt, artifactError: null, evidenceError: null });
      assert.equal(readFileSync(join(directory, String(index), 'stdout.log'), 'utf8'), 'out');
      assert.equal(readFileSync(join(directory, String(index), 'stderr.log'), 'utf8'), 'err');
      assert.equal(
        JSON.parse(readFileSync(join(directory, String(index), 'runner.json'), 'utf8')).code,
        code
      );
    }
    assert.equal(samplePassed({ focused: 2, full: 0, attempts, stageFailures: [] }), false);
    assert.equal(attempts[0].code, 42);
    assert.equal(attempts[1].code, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing attempts, launch failures, evidence failures and setup failures never establish repeatability', () => {
  const attempt = {
    code: 0,
    signal: null,
    launchError: null,
    artifactError: null,
    evidenceError: null,
    outputErrors: [],
    receiptWriteError: null,
  };
  const sample = { focused: 1, full: 0, attempts: [attempt], stageFailures: [] };
  assert.equal(samplePassed(sample), true);
  assert.equal(samplePassed({ ...sample, attempts: [] }), false);
  for (const failure of [
    { signal: 'SIGTERM' },
    { launchError: 'ENOENT' },
    { artifactError: 'copy failed' },
    { evidenceError: 'skipped test' },
    { code: 124 },
  ]) {
    assert.equal(samplePassed({ ...sample, attempts: [{ ...attempt, ...failure }] }), false);
  }
  assert.equal(samplePassed({ ...sample, stageFailures: [{ stage: 'install' }] }), false);
});

test('skips, incomplete discovery and failed suites cannot masquerade as a complete test sample', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-repeatability-evidence-'));
  try {
    const path = join(directory, 'vitest.json');
    const file = join(directory, 'scenario.test.ts');
    const passed = {
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: [{ name: file, status: 'passed', assertionResults: [{ status: 'passed' }] }],
    };
    writeFileSync(path, JSON.stringify(passed));
    assert.equal(readTestEvidence(path, [file]).summary.passed, 1);
    assert.equal(readTestEvidence(path, [file]).error, null);
    for (const failure of [
      { numPendingTests: 1 },
      { numTodoTests: 1 },
      { numPassedTests: 0 },
      { testResults: [] },
      { numFailedTestSuites: 1 },
      { success: false },
    ]) {
      writeFileSync(path, JSON.stringify({ ...passed, ...failure }));
      const evidence = readTestEvidence(path, [file]);
      assert.notEqual(evidence.error, null, JSON.stringify(failure));
      assert.equal(evidence.summary, null);
    }
    writeFileSync(path, '{');
    assert.deepEqual(readTestEvidence(path, [file]).cases, null);
    writeFileSync(path, JSON.stringify({ ...passed, testResults: [null] }));
    const malformed = readTestEvidence(path, [file]);
    assert.match(malformed.error, /^TypeError/u);
    assert.equal(malformed.summary, null);
    assert.equal(malformed.cases, null);
    assert.match(readTestEvidence(join(directory, 'missing.json'), [file]).error, /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each focused attempt proves all six reviewed files and all audio and crew cases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-focused-coverage-'));
  const { focusedScenarios } = validateSampleOptions({ manifest: 'current' });
  try {
    const path = join(directory, 'vitest.json');
    assert.deepEqual(
      focusedScenarios.map(({ count }) => count),
      [6, 7, 2, 3, 4, 1]
    );
    const files = focusedScenarios.map(({ path: file }) => file);
    const passed = {
      success: true,
      numTotalTests: 23,
      numPassedTests: 23,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: focusedScenarios.map(({ path: file, count }) => ({
        name: join(root, file),
        status: 'passed',
        assertionResults: Array.from({ length: count }, () => ({ status: 'passed' })),
      })),
    };
    const read = (evidence) => {
      writeFileSync(path, JSON.stringify(evidence));
      return readTestEvidence(path, files, focusedScenarios);
    };
    const rejects = (evidence) => assert.notEqual(read(evidence).error, null);
    assert.deepEqual(read(passed).summary, { total: 23, passed: 23, files: 6 });
    assert.equal(read(passed).cases.length, 23);
    rejects({ ...passed, testResults: passed.testResults.slice(0, 3) });
    rejects({ ...passed, testResults: [...passed.testResults, passed.testResults[0]] });
    rejects({ ...passed, numTotalTests: 22, numPassedTests: 22 });
    for (const missingCrewIndex of [4, 5]) {
      rejects({
        ...passed,
        testResults: passed.testResults.filter((_, index) => index !== missingCrewIndex),
      });
    }
    rejects({
      ...passed,
      numTotalTests: 18,
      numPassedTests: 18,
      testResults: passed.testResults.slice(0, 4),
    });
    const skipped = structuredClone(passed);
    skipped.testResults[2].assertionResults[0].status = 'pending';
    rejects(skipped);
    // A same-total count redistribution must not erase an audio combination.
    const redistributed = structuredClone(passed);
    redistributed.testResults[0].assertionResults.pop();
    redistributed.testResults[2].assertionResults.push({ status: 'passed' });
    rejects(redistributed);
    const redistributedCrew = structuredClone(passed);
    redistributedCrew.testResults[4].assertionResults.pop();
    redistributedCrew.testResults[5].assertionResults.push({ status: 'passed' });
    rejects(redistributedCrew);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('attempt archives retain changed evidence and identify old screenshots without relabeling them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-repeatability-artifacts-'));
  try {
    const source = join(directory, 'source');
    const destination = join(directory, 'attempt');
    mkdirSync(join(source, 'logs'), { recursive: true });
    mkdirSync(join(source, 'tests/integration/browser/screenshots'), { recursive: true });
    mkdirSync(destination);
    writeFileSync(join(source, 'logs/server.log'), 'failure detail');
    writeFileSync(join(source, 'tests/integration/browser/screenshots/old.json'), 'old');
    writeFileSync(join(source, 'tests/integration/browser/screenshots/current.json'), 'new');
    const previousScreenshots = new Map([
      ['old.json', 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4'],
    ]);
    retainArtifacts({ source, destination, previousScreenshots });
    assert.equal(readFileSync(join(destination, 'logs/server.log'), 'utf8'), 'failure detail');
    assert.equal(
      readFileSync(join(destination, 'tests/integration/browser/screenshots/current.json'), 'utf8'),
      'new'
    );
    assert.throws(() =>
      readFileSync(join(destination, 'tests/integration/browser/screenshots/old.json'))
    );
    const index = JSON.parse(readFileSync(join(destination, 'artifact-index.json'), 'utf8'));
    assert.equal(index.find((entry) => entry.file.endsWith('/old.json')).changed, false);
    assert.equal(index.find((entry) => entry.file.endsWith('/current.json')).changed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an artifact sink failure terminates its owned child and retains the original and receipt-write failures', {
  timeout: 5000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-output-failure-'));
  let pid;
  try {
    const args = [
      '-e',
      `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.cwd(), 'child.pid'), String(process.pid));
      process.on('SIGTERM', () => {
        fs.writeFileSync(path.join(process.cwd(), 'terminated'), 'TERM cleanup completed');
        process.exit(0);
      });
      fs.unlinkSync(path.join(process.cwd(), 'stdout.log'));
      fs.mkdirSync(path.join(process.cwd(), 'stdout.log'));
      fs.mkdirSync(path.join(process.cwd(), 'runner.json'));
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 2000);
      process.stdout.write('owned child still running');
    `,
    ];
    const result = await runAttempt({
      directory,
      command: process.execPath,
      args,
      cwd: directory,
      env: process.env,
    });
    pid = Number(readFileSync(join(directory, 'child.pid'), 'utf8'));
    assert.equal(result.stopRequested, true);
    assert.equal(result.code, 0, 'Even a successful TERM handler cannot erase output loss');
    assert.equal(readFileSync(join(directory, 'terminated'), 'utf8'), 'TERM cleanup completed');
    assert.ok(
      result.outputErrors.some(
        (error) => error.sink === 'stdout' && error.message.includes('EISDIR')
      )
    );
    assert.match(result.receiptWriteError, /EISDIR/u);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(
      samplePassed({
        focused: 1,
        full: 0,
        attempts: [{ ...result, artifactError: null, evidenceError: null }],
        stageFailures: [],
      }),
      false
    );
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Already reaped. */
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a console sink callback error stops the owned child without escaping the awaited attempt', {
  timeout: 5000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-console-failure-'));
  const failingConsole = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('console sink unavailable'));
    },
  });
  let pid;
  try {
    const result = await runAttempt({
      directory,
      command: process.execPath,
      args: [
        '-e',
        `
      const fs = require('node:fs');
      fs.writeFileSync('child.pid', String(process.pid));
      process.on('SIGTERM', () => { fs.writeFileSync('terminated', 'clean'); process.exit(0); });
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 2000);
      process.stdout.write('console output');
    `,
      ],
      cwd: directory,
      env: process.env,
      consoleOutput: { stdout: failingConsole, stderr: process.stderr },
    });
    pid = Number(readFileSync(join(directory, 'child.pid'), 'utf8'));
    assert.equal(result.stopRequested, true);
    assert.equal(result.code, 0);
    assert.deepEqual(result.outputErrors, [
      { sink: 'console-stdout', message: 'Error: console sink unavailable' },
    ]);
    assert.equal(result.receiptWriteError, null);
    assert.equal(readFileSync(join(directory, 'terminated'), 'utf8'), 'clean');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(
      samplePassed({
        focused: 1,
        full: 0,
        attempts: [{ ...result, artifactError: null, evidenceError: null }],
        stageFailures: [],
      }),
      false
    );
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Already reaped. */
      }
    }
    failingConsole.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a sample report tallies failing cases and flags slow full passes without failing them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-attempt-summary-'));
  try {
    const furnace = focusedFiles.furnaceTravel.path;
    const crawlers = focusedFiles.beltCrawlers.path;
    const prompt = 'the touch furnace prompt fits resized viewports and keeps Space from firing';
    const rides = 'a pilot rides their ship from a built furnace to Town Square and back at 1280px';
    const wiki = 'the controls Wiki explains mobile furnace ability access at 390px';
    const read = (name, testResults) => {
      const path = join(directory, `${name}.json`);
      writeFileSync(path, JSON.stringify({ success: false, testResults }));
      return readTestEvidence(path, [furnace, crawlers]);
    };
    const focused = read('focused-01', [
      {
        name: join(root, furnace),
        status: 'failed',
        message: '',
        assertionResults: [
          { fullName: rides, status: 'passed', failureMessages: [] },
          {
            fullName: prompt,
            status: 'failed',
            failureMessages: ['\nError: Test timed out in 30000ms.\n    at task (run.js:1:1)'],
          },
          { fullName: wiki, status: 'skipped', failureMessages: [] },
        ],
      },
    ]);
    const slowFailing = read('full-01', [
      {
        name: join(root, furnace),
        status: 'failed',
        message: '',
        assertionResults: [
          { fullName: rides, status: 'passed', failureMessages: [] },
          { fullName: prompt, status: 'failed', failureMessages: ['AssertionError: 1 !== 0'] },
        ],
      },
      {
        name: join(root, crawlers),
        status: 'failed',
        message: 'Error: beforeAll hook timed out\nstack line',
        assertionResults: [],
      },
    ]);
    const fast = read('full-02', [
      {
        name: join(root, furnace),
        status: 'passed',
        message: '',
        assertionResults: [{ fullName: prompt, status: 'passed', failureMessages: [] }],
      },
    ]);
    assert.notEqual(focused.error, null);
    assert.deepEqual(focused.cases[1], {
      file: furnace,
      fullName: prompt,
      status: 'failed',
      failure: 'Error: Test timed out in 30000ms.',
    });
    assert.deepEqual(slowFailing.cases.at(-1), {
      file: crawlers,
      fullName: null,
      status: 'failed',
      failure: 'Error: beforeAll hook timed out',
    });
    const outcome = (code, evidenceError) => ({ code, signal: null, evidenceError });
    const attempts = [
      {
        stage: 'focused',
        attempt: 1,
        durationMs: 131_000,
        ...outcome(1, focused.error),
        cases: focused.cases,
      },
      {
        stage: 'full',
        attempt: 1,
        durationMs: 1_104_300,
        deadlineMarginSeconds: 95.7,
        ...outcome(1, slowFailing.error),
        cases: slowFailing.cases,
      },
      {
        stage: 'full',
        attempt: 2,
        durationMs: 1_007_200,
        deadlineMarginSeconds: 192.8,
        ...outcome(0, null),
        cases: fast.cases,
      },
      // The runner deadline killed this attempt before Vitest wrote its JSON.
      {
        stage: 'full',
        attempt: 3,
        durationMs: 1_203_400,
        deadlineMarginSeconds: -3.4,
        ...outcome(124, "Error: ENOENT: no such file or directory, open 'vitest.json'\nstack"),
        cases: null,
      },
    ];
    const tallies = [
      {
        file: furnace,
        fullName: prompt,
        observed: 3,
        notPassed: 2,
        failures: [
          {
            stage: 'focused',
            attempt: 1,
            status: 'failed',
            failure: 'Error: Test timed out in 30000ms.',
          },
          { stage: 'full', attempt: 1, status: 'failed', failure: 'AssertionError: 1 !== 0' },
        ],
      },
      {
        file: crawlers,
        fullName: null,
        observed: 1,
        notPassed: 1,
        failures: [
          {
            stage: 'full',
            attempt: 1,
            status: 'failed',
            failure: 'Error: beforeAll hook timed out',
          },
        ],
      },
      {
        file: furnace,
        fullName: wiki,
        observed: 1,
        notPassed: 1,
        failures: [{ stage: 'focused', attempt: 1, status: 'skipped', failure: null }],
      },
    ];
    assert.equal(fullPassWatchSeconds, 1100);
    assert.deepEqual(summarizeAttempts(attempts), {
      caseFailureTallies: tallies,
      attemptsWithoutCaseEvidence: [
        {
          stage: 'full',
          attempt: 3,
          evidenceError: "Error: ENOENT: no such file or directory, open 'vitest.json'",
        },
      ],
      slowFullAttempts: [
        {
          stage: 'full',
          attempt: 1,
          durationSeconds: 1104.3,
          deadlineMarginSeconds: 95.7,
          code: 1,
          signal: null,
          evidenceFailed: true,
        },
        {
          stage: 'full',
          attempt: 3,
          durationSeconds: 1203.4,
          deadlineMarginSeconds: -3.4,
          code: 124,
          signal: null,
          evidenceFailed: true,
        },
      ],
    });
    assert.deepEqual(
      summarizeAttempts(attempts.slice(0, 3)).caseFailureTallies,
      tallies,
      'An attempt without case evidence leaves the tallies unchanged'
    );
    // A focused attempt above the threshold is not deadline-watched.
    assert.deepEqual(
      summarizeAttempts([{ ...attempts[0], durationMs: 1_150_000 }]).slowFullAttempts,
      []
    );
    const withoutSlowAttempts = summarizeAttempts([attempts[0], attempts[2]]);
    assert.deepEqual(withoutSlowAttempts.slowFullAttempts, []);
    assert.deepEqual(withoutSlowAttempts.attemptsWithoutCaseEvidence, []);
    assert.deepEqual(
      withoutSlowAttempts.caseFailureTallies.map(({ fullName, observed, notPassed }) => [
        fullName,
        observed,
        notPassed,
      ]),
      [
        [wiki, 1, 1],
        [prompt, 2, 1],
      ]
    );
    const clean = {
      code: 0,
      signal: null,
      launchError: null,
      artifactError: null,
      evidenceError: null,
      outputErrors: [],
      receiptWriteError: null,
    };
    assert.equal(
      samplePassed({
        focused: 0,
        full: 1,
        attempts: [{ ...clean, ...attempts[1], ...outcome(0, null), cases: [] }],
        stageFailures: [],
      }),
      true,
      'A slow full pass is data, not a failure'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the full-pass deadline margin uses the runner deadline that test-runner.sh would enforce', () => {
  const runner = readFileSync(join(root, 'scripts/test-runner.sh'), 'utf8');
  const shellDefault = runner.match(/\$\{GEOROIDS_TEST_MAX_DURATION_SECONDS:-(\d+)\}/u);
  assert.ok(shellDefault, 'test-runner.sh must declare its deadline default');
  assert.equal(runnerDeadlineSeconds({}), Number(shellDefault[1]));
  assert.equal(
    runnerDeadlineSeconds({ GEOROIDS_TEST_MAX_DURATION_SECONDS: '' }),
    Number(shellDefault[1])
  );
  // valid_positive_integer rejects empty, non-digits and a bare 0 only.
  assert.match(runner, /''\|\*\[!0-9\]\*\|0\) return 1/u);
  assert.equal(runnerDeadlineSeconds({ GEOROIDS_TEST_MAX_DURATION_SECONDS: '1500' }), 1500);
  assert.equal(runnerDeadlineSeconds({ GEOROIDS_TEST_MAX_DURATION_SECONDS: '0900' }), 900);
  assert.equal(runnerDeadlineSeconds({ GEOROIDS_TEST_MAX_DURATION_SECONDS: '00' }), 0);
  for (const rejected of ['0', '-5', '12.5', 'ten', ' 60']) {
    assert.equal(runnerDeadlineSeconds({ GEOROIDS_TEST_MAX_DURATION_SECONDS: rejected }), null);
  }
});

test('the workflow validates its pinned SHA before checkout and its sample through the script', () => {
  const workflow = parse(
    readFileSync(join(root, '.github/workflows/integration-repeatability.yml'), 'utf8')
  );
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['sha', 'manifest', 'focused', 'full']);
  for (const input of Object.values(inputs)) {
    assert.equal(input.type, 'string');
  }
  assert.equal(inputs.sha.required, true);
  assert.equal(inputs.manifest.default, 'current');
  assert.equal(inputs.focused.default, '20');
  assert.equal(inputs.full.default, '3');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = workflow.jobs['native-sample'];
  assert.equal(job['timeout-minutes'], 180);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.env.SAMPLE_SHA, `\${{ inputs.sha }}`);
  assert.equal(job.env.SAMPLE_MANIFEST, `\${{ inputs.manifest }}`);
  assert.equal(job.env.SAMPLE_FOCUSED, `\${{ inputs.focused }}`);
  assert.equal(job.env.SAMPLE_FULL, `\${{ inputs.full }}`);
  const names = job.steps.map((step) => step.name ?? step.uses);
  const at = (name) => {
    const index = names.findIndex((entry) => entry.startsWith(name));
    assert.notEqual(index, -1, name);
    return index;
  };
  assert.ok(at('Validate the pinned revision') < at('actions/checkout@'));
  assert.ok(at('actions/setup-node@') < at('Validate the sample selection'));
  assert.ok(at('Validate the sample selection') < at('Install native canvas'));
  const checkout = job.steps[at('actions/checkout@')];
  assert.equal(checkout.with.ref, `\${{ inputs.sha }}`);
  assert.equal(checkout.with['persist-credentials'], false);
  for (const step of job.steps.filter((entry) => entry.run)) {
    assert.doesNotMatch(step.run, /\$\{\{/u, `${step.name} must read inputs through env`);
  }
  const guard = job.steps[at('Require a main revision')].run;
  assert.match(guard, /test "\$\(git rev-parse HEAD\)" = "\$SAMPLE_SHA"/u);
  assert.match(guard, /git merge-base --is-ancestor "\$SAMPLE_SHA" origin\/main/u);
  const sample = job.steps[at('Run the bounded serialized sample')].run;
  assert.match(sample, /--sha "\$SAMPLE_SHA" --manifest "\$SAMPLE_MANIFEST"/u);
  assert.match(sample, /--focused "\$SAMPLE_FOCUSED" --full "\$SAMPLE_FULL"/u);
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\./u);

  const revisionCheck = job.steps[at('Validate the pinned revision')].run;
  const sampleCheck = job.steps[at('Validate the sample selection')].run;
  const directory = mkdtempSync(join(tmpdir(), 'georoids-repeatability-workflow-'));
  const artifacts = join(directory, 'artifacts');
  mkdirSync(artifacts);
  const run = (script, env) =>
    spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: directory,
        ARTIFACTS: artifacts,
        GITHUB_ENV: join(directory, 'env'),
        GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
        EXPECTED_ARCHITECTURE: 'x64',
        SAMPLE_SHA: sha,
        SAMPLE_MANIFEST: 'current',
        SAMPLE_FOCUSED: '20',
        SAMPLE_FULL: '3',
        ...env,
      },
    });
  try {
    assert.equal(run(revisionCheck, {}).status, 0);
    for (const rejected of ['', 'main', 'A'.repeat(40)]) {
      assert.equal(run(revisionCheck, { SAMPLE_SHA: rejected }).status, 64, rejected);
    }
    const accepted = run(sampleCheck, {
      SAMPLE_MANIFEST: 'flake-classification',
      SAMPLE_FOCUSED: '20',
      SAMPLE_FULL: '0',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    const line = `x64 ${sha}: manifest flake-classification, 20 focused, 0 full\n`;
    assert.equal(readFileSync(join(directory, 'summary.md'), 'utf8'), line);
    assert.equal(readFileSync(join(artifacts, 'setup.txt'), 'utf8'), line);
    for (const [rejected, message] of [
      [{ SAMPLE_MANIFEST: 'audio' }, /Unknown manifest "audio"/u],
      [{ SAMPLE_FOCUSED: '21' }, /--focused exceeds the approved sample of 20/u],
      [{ SAMPLE_FOCUSED: '0', SAMPLE_FULL: '0' }, /At least one attempt is required/u],
    ]) {
      const result = run(sampleCheck, rejected);
      assert.equal(result.status, 64, JSON.stringify(rejected));
      assert.match(result.stderr, message);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
