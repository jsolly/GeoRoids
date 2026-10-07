// GeoRoids server release admission; canonical smoke runner owns HTTP/WebSocket receipts.
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const FULL_SHA = /^[a-f0-9]{40}$/iu;
const RELEASE_SHA = /^[a-f0-9]{40}$/iu;
// Read-only fetch authentication stays private to this module's Git fetch.
const fetchToken = process.env.PRODUCTION_SMOKE_GITHUB_TOKEN;
delete process.env.PRODUCTION_SMOKE_GITHUB_TOKEN;

export function fullSha(value) {
  if (!FULL_SHA.test(value ?? '')) {
    throw new Error('Expected full 40-character commit SHA');
  }
  return value.toLowerCase();
}
export function verifyAncestry(expected, observed, git = execFileSync) {
  fullSha(expected);
  if (!RELEASE_SHA.test(observed ?? '')) {
    throw new Error(`Invalid release identity: ${observed}`);
  }
  let actual;
  try {
    actual = git('git', ['rev-parse', '--verify', `${observed}^{commit}`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // A newer production deploy may land after this workflow checked out main.
    git('git', ['fetch', '--no-tags', 'origin', 'main'], {
      timeout: 15000,
      env: fetchToken
        ? {
            ...process.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${fetchToken}`).toString('base64')}`,
          }
        : process.env,
    });
    actual = git('git', ['rev-parse', '--verify', `${observed}^{commit}`], {
      encoding: 'utf8',
    }).trim();
  }
  fullSha(actual);
  git('git', ['merge-base', '--is-ancestor', expected, actual]);
  return actual;
}
