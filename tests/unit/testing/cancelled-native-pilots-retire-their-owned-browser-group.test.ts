// @vitest-environment node
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it as test } from 'vitest';

const launcher = fileURLToPath(new URL('../../support/owned-native-browser.mjs', import.meta.url));

function exited(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned process fixture timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function groupAbsent(group: number): boolean {
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    assert(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    return true;
  }
}

async function waitForGroupExit(group: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!groupAbsent(group) && Date.now() < deadline) {
    await delay(25);
  }
  expect(groupAbsent(group)).toBe(true);
}

test('a native pilot closing normally retires its launcher', async () => {
  const child = spawn(process.execPath, [launcher, process.execPath, '-e', 'process.exit(0)'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  assert(child.pid);
  const group = child.pid;
  try {
    expect(await bounded(exited(child))).toEqual({ code: null, signal: 'SIGKILL' });
    await waitForGroupExit(group);
  } finally {
    if (!groupAbsent(group)) {
      process.kill(-group, 'SIGKILL');
    }
  }
}, 10000);

test('a crashed browser leader leaves no surviving descendants in its owned group', async () => {
  const descendant =
    "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
  const browser = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', () => {
      console.error(JSON.stringify({ descendant: child.pid }));
      process.exit(7);
    });
  `;
  const child = spawn(process.execPath, [launcher, process.execPath, '-e', browser], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  assert(child.pid && child.stderr);
  const group = child.pid;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    expect(await bounded(exited(child))).toEqual({ code: null, signal: 'SIGKILL' });
    expect(stderr).toContain('"descendant":');
    expect(stderr).toContain('Owned Chromium exited 7/null');
    await waitForGroupExit(group);
  } finally {
    if (!groupAbsent(group)) {
      process.kill(-group, 'SIGKILL');
    }
  }
}, 10000);

test('killing a native pilot worker retires its browser and descendants that ignore TERM', async () => {
  const descendant =
    "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);";
  const browser = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', () => console.error(JSON.stringify({ browser: process.pid, descendant: child.pid })));
    setInterval(() => {}, 1000);
  `;
  const ownerSource = String.raw`
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(launcher)}, process.execPath, '-e', ${JSON.stringify(browser)}], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let buffer = '';
    child.stderr.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        process.send({ group: child.pid, ...JSON.parse(buffer.slice(0, newline)) });
        buffer = buffer.slice(newline + 1);
      }
    });
  `;
  const owner = spawn(process.execPath, ['-e', ownerSource], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ownerExit = exited(owner);
  let group: number | undefined;
  try {
    const ready = await bounded(
      new Promise<unknown>((resolve, reject) => {
        owner.once('message', resolve);
        owner.once('error', reject);
        owner.once('exit', () =>
          reject(new Error('Fixture owner exited before its browser was ready'))
        );
      })
    );
    assert(typeof ready === 'object' && ready !== null && 'group' in ready);
    assert(typeof ready.group === 'number' && Number.isSafeInteger(ready.group));
    group = ready.group;
    expect(groupAbsent(group)).toBe(false);
    owner.kill('SIGKILL');
    await bounded(ownerExit);
    await waitForGroupExit(group);
  } finally {
    owner.kill('SIGKILL');
    await bounded(ownerExit);
    if (group !== undefined && !groupAbsent(group)) {
      process.kill(-group, 'SIGKILL');
    }
  }
}, 10000);
