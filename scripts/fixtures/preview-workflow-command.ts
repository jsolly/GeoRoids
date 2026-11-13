import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function setting(name: string): string {
  const value = process.env[name];
  assert.ok(typeof value === 'string', `Missing fixture setting ${name}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const entry = process.argv[1];
assert.ok(entry);
const command = path.basename(entry);
const args = process.argv.slice(2);
const log = (value: Record<string, unknown>) =>
  fs.appendFileSync(setting('FIXTURE_CALLS'), `${JSON.stringify(value)}\n`);

if (command === 'gh') {
  if (args[0] === 'api') {
    log({ command, args });
    if (args[1] === '--method') {
      assert.deepEqual(args, [
        'api',
        '--method',
        'GET',
        'repos/jsolly/GeoRoids/collaborators/solly-agent/permission',
        '--jq',
        '.permission',
      ]);
      if (setting('FIXTURE_PERMISSION_FAIL') === '1') {
        process.exit(1);
      }
      process.stdout.write(setting('FIXTURE_PERMISSION'));
    } else {
      assert.deepEqual(args, ['api', 'repos/jsolly/GeoRoids/pulls/814']);
      if (setting('FIXTURE_API_FAIL') === '1') {
        process.exit(1);
      }
      process.stdout.write(setting('FIXTURE_PR'));
    }
  } else if (args[0] === 'pr' && args[1] === 'comment') {
    log({ command, args });
  } else {
    throw new Error('Unexpected gh invocation');
  }
} else if (command === 'jq') {
  const pr = record(JSON.parse(fs.readFileSync(0, 'utf8')));
  const head = record(pr['head']);
  const repo = head['repo'];
  const fields: Record<string, unknown> = {
    '.state': pr['state'],
    '.head.sha': head['sha'],
    '.head.ref': head['ref'],
    '.head.repo.full_name // empty': repo === undefined ? '' : (record(repo)['full_name'] ?? ''),
  };
  const key = args[1];
  assert.ok(args[0] === '-r' && key !== undefined && Object.hasOwn(fields, key));
  process.stdout.write(`${String(fields[key])}\n`);
} else if (command === 'git') {
  assert.deepEqual(args, ['rev-parse', 'HEAD']);
  process.stdout.write(`${setting('FIXTURE_CHECKOUT_SHA')}\n`);
} else if (command === 'timeout') {
  assert.ok(args[0] === '900' && args[1] === 'npm');
  const result = spawnSync(args[1], args.slice(2), { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 99);
} else if (command === 'npm') {
  assert.equal(process.cwd(), setting('RUNNER_TEMP'), 'npm ran inside the PR tree');
  const workspace = setting('GITHUB_WORKSPACE');
  assert.equal(
    fs.existsSync(path.join(workspace, '.railway')),
    false,
    'Production IaC reached upload'
  );
  assert.equal(
    fs.readFileSync(path.join(workspace, 'public/preview-release.txt'), 'utf8').trim(),
    setting('HEAD_SHA'),
    'Upload did not carry the requested SHA'
  );
  log({ command, args, cwd: process.cwd() });
  if (setting('FIXTURE_UPLOAD_FAIL') === '1') {
    process.exit(73);
  }
} else if (command === 'curl') {
  const url = args.at(-1);
  assert.ok(url);
  log({ command, url });
  if (url.endsWith('/preview-release.txt')) {
    process.stdout.write(`${setting('FIXTURE_SERVED_SHA')}\n`);
  } else if (url.endsWith('/health')) {
    if (setting('FIXTURE_HEALTH_FAIL') === '1') {
      process.exit(22);
    }
  } else if (url.endsWith('/')) {
    if (setting('FIXTURE_HTML_FAIL') === '1') {
      process.stdout.write('{}');
    } else {
      // Real curl reports 23 when grep -q closes the healthy HTML stream early.
      process.stdout.on('error', (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'EPIPE') {
          process.exit(23);
        }
        throw error;
      });
      process.stdout.write('<html>\n');
      let remaining = 64;
      const stream = (): void => {
        if (remaining-- === 0) {
          process.stdout.end('</html>');
          return;
        }
        if (process.stdout.write('x'.repeat(64 * 1024))) {
          setImmediate(stream);
        } else {
          process.stdout.once('drain', stream);
        }
      };
      setImmediate(stream);
    }
  } else {
    throw new Error('Unexpected curl destination');
  }
} else if (command !== 'sleep') {
  throw new Error('Unexpected fixture command');
}
