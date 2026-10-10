import { execFileSync } from 'node:child_process';
import process from 'node:process';

const COMMIT_SHA = /^[a-f0-9]{40}$/iu;

/** Resolve independently of generated output, including hosted archives without .git. */
export function clientReleaseSha(root = process.cwd()): string {
  for (const value of [
    process.env['VERCEL_GIT_COMMIT_SHA'],
    process.env['RAILWAY_GIT_COMMIT_SHA'],
  ]) {
    if (typeof value === 'string' && COMMIT_SHA.test(value)) {
      return value.toLowerCase();
    }
  }
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  if (!COMMIT_SHA.test(sha)) {
    throw new Error('Cannot build client without a valid Git commit SHA');
  }
  return sha.toLowerCase();
}
