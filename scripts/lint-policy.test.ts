import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

test('lint-policy shell fixtures preserve every contract assertion and cleanup', () => {
  const result = spawnSync('bash', ['scripts/lint-policy-contract.sh'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
