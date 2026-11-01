import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const selector = fileURLToPath(new URL('./test-ports.mjs', import.meta.url));
interface SelectionResult {
  code: number | null;
  output: string;
  diagnostic: string;
}

function select(ports: readonly string[]): Promise<SelectionResult> {
  return new Promise<SelectionResult>((accept, reject) => {
    const child = spawn(process.execPath, [selector, ...ports]);
    let output = '';
    let diagnostic = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => accept({ code, output, diagnostic }));
  });
}

test('a standalone harness chooses three distinct ports while defaults belong to another service', async () => {
  const occupied = createServer();
  await new Promise<void>((accept, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', accept);
  });
  try {
    const address = occupied.address();
    assert(address && typeof address !== 'string');
    const result = await select(['', '', '']);
    assert.equal(result.code, 0, result.diagnostic);
    const ports = result.output.trim().split('\n').map(Number);
    assert.equal(ports.length, 3);
    assert.equal(new Set(ports).size, 3);
    assert(!ports.includes(address.port));
    assert(occupied.listening);
  } finally {
    await new Promise<void>((accept, reject) =>
      occupied.close((error) => (error ? reject(error) : accept()))
    );
  }
});

test('explicit diagnostic selections survive automatic selection of remaining ports', async () => {
  const result = await select(['59991', '', '59993']);
  assert.equal(result.code, 0, result.diagnostic);
  const ports = result.output.trim().split('\n');
  assert.equal(ports[0], '59991');
  assert.equal(ports[2], '59993');
  const automatic = ports[1];
  assert(automatic !== undefined);
  assert(!['59991', '59993'].includes(automatic));
});

test('duplicate or invalid explicit selections fail before any harness starts', async () => {
  for (const ports of [
    ['123', '123', ''],
    ['0', '', ''],
    ['abc', '', ''],
    ['65536', '', ''],
  ]) {
    const result = await select(ports);
    assert.notEqual(result.code, 0);
    assert.equal(result.output, '');
    assert.match(result.diagnostic, /valid and distinct/u);
  }
});
