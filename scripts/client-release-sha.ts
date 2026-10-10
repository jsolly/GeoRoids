import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

const COMMIT_SHA = /^[a-f0-9]{40}$/iu;

/** Prefer host/Git metadata; archives without either receive one opaque build token. */
export function clientReleaseSha(root = process.cwd()): string {
  for (const value of [
    process.env['VERCEL_GIT_COMMIT_SHA'],
    process.env['RAILWAY_GIT_COMMIT_SHA'],
  ]) {
    if (typeof value === 'string' && COMMIT_SHA.test(value)) {
      return value.toLowerCase();
    }
  }
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (COMMIT_SHA.test(sha)) {
      return sha.toLowerCase();
    }
  } catch {
    // Git metadata is optional. One token is shared by this build's client and manifest.
  }
  return randomBytes(20).toString('hex');
}
