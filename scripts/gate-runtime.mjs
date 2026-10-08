import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inheritAdmission, receiptEnvironment, runAdmitted } from './validation-admission.mjs';

export function lifecycleCommand(root, environment, entry, mode = '--validation-child') {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert(
    !['env', 'preenv', 'postenv'].some((name) => Object.hasOwn(manifest.scripts ?? {}, name)),
    "Validation requires npm's built-in env lifecycle"
  );
  const npm = (environment.PATH ?? '')
    .split(':')
    .map((path) => join(path, 'npm'))
    .find(existsSync);
  assert(npm, 'Missing npm validation runtime');
  // One actual npm lifecycle supplies the same effective defaults to manual and
  // hook launches. This invokes the existing battery, never the pre-commit hook.
  return [process.execPath, realpathSync(npm), 'run', 'env', '--', process.execPath, entry, mode];
}

export function canonicalEnvironment(root, environment) {
  const result = spawnSync('git', ['--exec-path'], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert(
    !result.error && !result.signal && result.status === 0 && !result.stderr.trim(),
    'Cannot identify Git hook runtime path'
  );
  const core = result.stdout.trim();
  assert(isAbsolute(core) && !core.includes('\n'), 'Invalid Git hook runtime path');
  let paths = (environment.PATH ?? '').split(':');
  if (Object.hasOwn(environment, 'GIT_PREFIX')) {
    // Git prepends this helper directory to hook PATH. Use the caller's ordinary
    // frontend, preserving every other PATH component and its precedence.
    paths = paths.filter((path) => path !== core);
  }
  const env = {
    ...environment,
    PATH: [...new Set([...paths, core])].join(':'),
    FLEET_DOC_FAST: '0',
  };
  delete env.GIT_PREFIX;
  // These belong to the host's interactive REPL, not the owned file-based Node
  // program. Remove them from execution itself instead of ignoring their digest.
  for (const key of [
    'NODE_REPL_NODE_MODULE_DIRS',
    'NODE_REPL_TRUSTED_CODE_PATHS',
    'NODE_REPL_TRUSTED_SERVICES',
  ]) {
    delete env[key];
  }
  return env;
}

async function lifecycleEnvironment(root, environment, timeoutMs) {
  const command = lifecycleCommand(
    root,
    environment,
    fileURLToPath(import.meta.url),
    '--runtime-environment'
  );
  // Use the existing supervisor for setup too: npm and its script-shell
  // descendants have authenticated group ownership, cancellation and cleanup.
  const result = await runAdmitted('checkout', command, {
    root,
    environment,
    timeoutMs,
    captureOutput: true,
  });
  assert(result.code === 0, `Cannot resolve npm validation environment (exit=${result.code})`);
  const prefix = 'GEOROIDS_RUNTIME_ENV:';
  const line = result.stdout.split('\n').find((row) => row.startsWith(prefix));
  assert(line, 'Missing npm validation environment');
  // Environment values stay in memory and are never diagnostic artifacts.
  return JSON.parse(line.slice(prefix.length));
}

export async function validationLaunch(root, environment, entry, { timeoutMs = 20000 } = {}) {
  return {
    command: [process.execPath, entry, '--validation-child'],
    environment: inheritAdmission(
      root,
      environment,
      await lifecycleEnvironment(root, environment, timeoutMs)
    ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2] === '--runtime-environment', 'Unknown runtime environment command');
  process.stdout.write(
    `GEOROIDS_RUNTIME_ENV:${JSON.stringify(canonicalEnvironment(process.cwd(), receiptEnvironment(process.cwd(), process.env)))}\n`
  );
}
