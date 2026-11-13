import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

interface Mutation {
  name: string;
  path: string;
  before: string;
  after: string;
  test: string;
  scenario: string;
  occurrences?: number;
}
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

function sourcePath(entry: string): string {
  const path = resolve(root, entry);
  const local = relative(root, path);
  assert(local === entry && !isAbsolute(entry), 'Expected checkout-relative source path');
  const parts = local.split('/');
  assert(
    parts.every((part) => part !== '..' && !part.startsWith('.')) &&
      (/^(benchmarks|content|docs|scripts|server|shared|src|tests)\//u.test(local) ||
        local === 'server.ts' ||
        local === 'sharedtypes.ts') &&
      /\.(?:[cm]?tsx?|[cm]?jsx?|md|svelte|astro|css|html|svg)$/u.test(local),
    'Expected authored source path, not a control path'
  );
  let ancestor = root;
  for (const part of parts) {
    ancestor = join(ancestor, part);
    assert(!lstatSync(ancestor).isSymbolicLink(), 'Source symlink is forbidden');
  }
  const actual = realpathSync(path);
  const actualLocal = relative(root, actual);
  assert(
    actualLocal !== '..' && !actualLocal.startsWith('../') && !isAbsolute(actualLocal),
    'Source real path escaped checkout'
  );
  const stat = lstatSync(actual);
  assert(stat.isFile(), 'Source must be a regular file');
  assert.equal(stat.nlink, 1, 'Multiply-linked source is forbidden');
  return actual;
}
const [destination, ownedInventory] = process.argv.slice(2);
if (!destination || !isAbsolute(destination)) {
  throw new Error('Expected new absolute evidence directory');
}
mkdirSync(destination, { mode: 0o700 });
const ownedPaths: string[] = [];
if (ownedInventory) {
  assert(isAbsolute(ownedInventory), 'Expected absolute owned-source inventory');
  const value: unknown = JSON.parse(readFileSync(ownedInventory, 'utf8'));
  assert(Array.isArray(value), 'Expected an array of owned source paths');
  for (const entry of value) {
    assert(typeof entry === 'string', 'Expected owned path string');
    ownedPaths.push(sourcePath(entry));
  }
}
const ownedOriginals = new Map(ownedPaths.map((path) => [path, readFileSync(path)]));
const restorations: {
  name: string;
  sources: Record<string, string>;
  unexpectedChanges: string[];
}[] = [];

const tileTests = 'tests/unit/server/exploration-tiles-survive-checkpoints.test.ts';
const mutations: Mutation[] = [
  {
    name: 'erase-newer-dirty-tile',
    path: 'shared/exploration.ts',
    before: 'this.dirty.get(id) === bits',
    after: 'true',
    test: 'tests/unit/shared/revealing-ground-keeps-the-map-re-encode-out-of-the-frame.test.ts',
    scenario: 'persistence acceptance retains newer discoveries',
  },
  {
    name: 'drop-worker-tiles',
    path: 'server/world/WorkerWorldPersistence.ts',
    before: 'exploration: batch.exploration,',
    after: 'exploration: undefined,',
    test: tileTests,
    scenario: 'a real worker clones tile batches',
  },
  {
    name: 'skip-existing-tile-update',
    path: 'server/world/WorldStore.ts',
    before: 'ON CONFLICT(id) DO UPDATE SET bits=excluded.bits',
    after: 'ON CONFLICT(id) DO NOTHING',
    test: tileTests,
    scenario: 'one survey cell writes one tile',
  },
  {
    name: 'skip-generation-check',
    path: 'server/world/WorldStore.ts',
    before: 'storage.world && storage.world.generation !== WORLD.generation',
    after: 'false',
    test: tileTests,
    scenario: 'an existing generation',
  },
  {
    name: 'lose-opaque-metadata',
    path: 'server/world/WorldStore.ts',
    before: 'const absent = owned.filter((key) => !Object.hasOwn(world, key));',
    after: "const absent = [...owned.filter((key) => !Object.hasOwn(world, key)), 'opaque'];",
    test: tileTests,
    scenario: 'first engine metadata checkpoint preserves opaque',
  },
  {
    name: 'omit-transaction-rollback',
    path: 'server/world/WorldStore.ts',
    before: 'this.rollback();',
    after: 'void 0;',
    test: tileTests,
    scenario: 'failed replacement rolls back tiles',
    occurrences: 2,
  },
  {
    name: 'omit-reset-tiles',
    path: 'server/world/WorldStore.ts',
    before:
      'DELETE FROM sectors; DELETE FROM pilots; DELETE FROM world; DELETE FROM economy; DELETE FROM exploration;',
    after: 'DELETE FROM sectors; DELETE FROM pilots; DELETE FROM world; DELETE FROM economy;',
    test: tileTests,
    scenario: 'diagnostic replacement clears even an empty map',
  },
  {
    name: 'omit-replacement-delete',
    path: 'server/world/WorldStore.ts',
    before: "if (exploration?.kind === 'replace')",
    after: 'if (false)',
    test: tileTests,
    scenario: 'diagnostic replacement clears even an empty map',
  },
  {
    name: 'accept-before-handover',
    path: 'server/core/GameEngine.ts',
    before: 'this.persistence.persist({',
    after: 'this.exploration.accepted(tiles); this.persistence.persist({',
    test: 'tests/unit/server/world-writes-leave-the-game-loop-once-a-second.test.ts',
    scenario: 'a synchronously refused batch never accepts dirty exploration',
  },
];
// Validate every fixed target before the first mutation, including without an inventory.
for (const mutation of mutations) {
  sourcePath(mutation.path);
}
const receipts: { name: string; originalSha256: string; rejected: true }[] = [];
for (const mutation of mutations) {
  const path = sourcePath(mutation.path);
  const original = readFileSync(path, 'utf8');
  assert.equal(
    original.split(mutation.before).length,
    (mutation.occurrences ?? 1) + 1,
    `Mutation anchor changed: ${mutation.name}`
  );
  const originalSha256 = createHash('sha256').update(original).digest('hex');
  const changed = original.replace(mutation.before, mutation.after);
  try {
    assert.equal(sourcePath(mutation.path), path);
    assert.equal(readFileSync(path, 'utf8'), original, 'Mutation target changed before write');
    writeFileSync(path, changed);
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        'config/testing/vitest.ts',
        '--project',
        'unit',
        mutation.test,
        '-t',
        mutation.scenario,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, SERVER_LOG_LEVEL: 'error' },
      }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    writeFileSync(join(destination, `${mutation.name}.log`), output, { mode: 0o600, flag: 'wx' });
    if (result.error || result.signal) {
      throw new Error(`Mutation failed to execute: ${mutation.name}`, { cause: result.error });
    }
    assert.notEqual(result.status, 0, `Regression survived mutation: ${mutation.name}`);
    assert.match(output, /AssertionError/u, `No causal assertion failed: ${mutation.name}`);
    assert.match(
      output,
      new RegExp(mutation.scenario, 'u'),
      `Selected scenario did not run: ${mutation.name}`
    );
    receipts.push({ name: mutation.name, originalSha256, rejected: true });
    process.stdout.write(`${mutation.name}: rejected\n`);
  } finally {
    const unexpectedChanges: string[] = [];
    // Only undo our exact mutation. Preserve unexpected edits, including on the target.
    try {
      assert.equal(sourcePath(mutation.path), path);
      assert.equal(readFileSync(path, 'utf8'), changed);
      writeFileSync(path, original);
    } catch {
      unexpectedChanges.push(mutation.path);
    }
    const sources: Record<string, string> = {};
    for (const [ownedPath, bytes] of ownedOriginals) {
      const local = relative(root, ownedPath);
      try {
        const actual = createHash('sha256')
          .update(readFileSync(sourcePath(local)))
          .digest('hex');
        const expected = createHash('sha256').update(bytes).digest('hex');
        if (actual !== expected) {
          unexpectedChanges.push(local);
        }
        sources[local] = actual;
      } catch {
        unexpectedChanges.push(local);
      }
    }
    restorations.push({ name: mutation.name, sources, unexpectedChanges });
    writeFileSync(
      join(destination, 'restorations.json'),
      `${JSON.stringify(restorations, null, 2)}\n`,
      {
        mode: 0o600,
      }
    );
    assert.deepEqual(
      unexpectedChanges,
      [],
      'Unexpected source changes; preserved without overwrite'
    );
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), originalSha256);
  }
}
writeFileSync(
  join(destination, 'receipt.json'),
  `${JSON.stringify({ mutations: receipts, restorations, restored: true }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 }
);
