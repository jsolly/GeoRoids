import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import {
  focusedScenarios,
  parseOptions,
  readTestEvidence,
  retainArtifacts,
  runAttempt,
  samplePassed,
} from './integration-repeatability.mjs';

const sha = 'a'.repeat(40);

test('pinned samples reject malformed revisions, empty samples and excess repetitions', () => {
  const base = ['--sha', sha, '--output', '/tmp/native-repeatability-contract'];
  assert.equal(parseOptions(base).focused, 20);
  assert.equal(parseOptions(base).full, 3);
  for (const args of [
    ['--sha', 'main', '--output', '/tmp/native-repeatability-contract'],
    [...base, '--focused', '21'],
    [...base, '--full', '4'],
    [...base, '--focused', '0', '--full', '0'],
    [...base, '--focused', '-1'],
    [...base, '--sha'],
    [...base, '--retry', '2'],
  ]) {
    assert.throws(() => parseOptions(args));
  }
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
    assert.equal(readTestEvidence(path, [file]).passed, 1);
    for (const failure of [
      { numPendingTests: 1 },
      { numTodoTests: 1 },
      { numPassedTests: 0 },
      { testResults: [] },
      { numFailedTestSuites: 1 },
      { success: false },
    ]) {
      writeFileSync(path, JSON.stringify({ ...passed, ...failure }));
      assert.throws(() => readTestEvidence(path, [file]));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each focused attempt proves all four reviewed files and all six audio combinations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-focused-coverage-'));
  try {
    const path = join(directory, 'vitest.json');
    assert.deepEqual(
      focusedScenarios.map(({ count }) => count),
      [6, 7, 2, 3]
    );
    const files = focusedScenarios.map(({ path: file }) => file);
    const passed = {
      success: true,
      numTotalTests: 18,
      numPassedTests: 18,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      testResults: focusedScenarios.map(({ path: file, count }) => ({
        name: file,
        status: 'passed',
        assertionResults: Array.from({ length: count }, () => ({ status: 'passed' })),
      })),
    };
    const read = (evidence) => {
      writeFileSync(path, JSON.stringify(evidence));
      return readTestEvidence(path, files, focusedScenarios);
    };
    assert.deepEqual(read(passed), { total: 18, passed: 18, files: 4 });
    assert.throws(() => read({ ...passed, testResults: passed.testResults.slice(0, 3) }));
    assert.throws(() =>
      read({ ...passed, testResults: [...passed.testResults, passed.testResults[0]] })
    );
    assert.throws(() => read({ ...passed, numTotalTests: 17, numPassedTests: 17 }));
    const skipped = structuredClone(passed);
    skipped.testResults[2].assertionResults[0].status = 'pending';
    assert.throws(() => read(skipped));
    // A same-total count redistribution must not erase an audio combination.
    const redistributed = structuredClone(passed);
    redistributed.testResults[0].assertionResults.pop();
    redistributed.testResults[2].assertionResults.push({ status: 'passed' });
    assert.throws(() => read(redistributed));
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
