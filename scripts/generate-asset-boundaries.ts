import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2];
assert(mode === '--check' || mode === '--write', 'Expected --check or --write');
const artifacts = [
  { file: 'production-smoke-scenario.mjs', source: 'production-smoke-scenario.mts' },
  { file: 'production-smoke-entry.mjs', source: 'production-smoke-entry.mts' },
  { file: 'production-smoke-network.mjs', source: 'production-smoke-network.mts' },
  { file: 'build-vercel-output.mjs', source: 'build-vercel-output.mts' },
  { file: 'verify-retained-assets.mjs', source: 'verify-retained-assets.mts' },
  { file: 'benchmark-build-receipt.mjs', source: 'benchmark-build-receipt.mts' },
  { file: 'merge-wiki-ledger.mjs', source: 'merge-wiki-ledger.mts' },
  { file: 'client-asset-graph.js', source: 'client-asset-graph.ts' },
];

function compile(args: readonly string[]): void {
  // Keep the repository's TS7 CLI selection; framework diagnostics still use TS6.
  const result = spawnSync(process.execPath, [join(root, 'scripts/typescript-cli.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout || 'TypeScript compilation failed');
}

// Typecheck every authored tool, test and this generator before emitting any boundary.
compile(['--project', 'config/typescript/asset-tools-check.json', '--noEmit']);
const temporary = mkdtempSync(join(tmpdir(), 'georoids-asset-boundaries-'));
try {
  compile(['--project', 'config/typescript/asset-tools-emit.json', '--outDir', temporary]);
  assert.deepEqual(
    readdirSync(temporary).sort(),
    artifacts.map(({ file }) => file).sort((a, b) => a.localeCompare(b)),
    'Asset boundary dependency inventory changed; include every emitted runtime module'
  );
  const output = artifacts.map(({ file, source }) => {
    const banner = `// Generated from ${source} by generate-asset-boundaries.ts; do not edit.\n`;
    const compiled = readFileSync(join(temporary, file), 'utf8');
    const hashbang = compiled.match(/^#![^\n]*\n/u)?.[0] ?? '';
    const generated = hashbang + banner + compiled.slice(hashbang.length);
    const result = spawnSync(
      join(root, 'node_modules/.bin/biome'),
      [
        'check',
        '--write',
        '--only=assist/source/organizeImports',
        '--config-path=config/quality/biome.settings.jsonc',
        `--stdin-file-path=scripts/${file}`,
      ],
      { cwd: root, input: generated, encoding: 'utf8' }
    );
    if (result.error) {
      throw result.error;
    }
    assert.equal(result.status, 0, result.stderr || 'Generated boundary formatting failed');
    return { target: join(root, 'scripts', file), text: result.stdout };
  });
  for (const { target, text } of output) {
    if (mode === '--check') {
      assert(
        existsSync(target) && readFileSync(target, 'utf8') === text,
        `Stale generated asset boundary: ${target}; run node scripts/generate-asset-boundaries.ts --write`
      );
    } else {
      writeFileSync(target, text);
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
