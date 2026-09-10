import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('a changed wiki entrypoint or newly added game rule requires a new documentation review', () => {
  const root = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-review-'));
  const baseline: unknown = JSON.parse(readFileSync('docs/wiki-source-review.json', 'utf8'));
  if (
    !baseline ||
    typeof baseline !== 'object' ||
    !('hashes' in baseline) ||
    !baseline.hashes ||
    typeof baseline.hashes !== 'object'
  ) {
    throw new Error('Wiki source review must exist before testing its invalidation');
  }
  try {
    // A disposable copy exercises the real CLI without mutating a developer's
    // checkout or racing another task. Include uncited transitive client imports.
    cpSync('src', join(fixture, 'src'), { recursive: true });
    for (const path of [...Object.keys(baseline.hashes), 'docs/wiki-source-review.json']) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target);
    }
    const check = (): string =>
      execFileSync(
        process.execPath,
        [resolve(root, 'node_modules/tsx/dist/cli.mjs'), join(fixture, 'scripts/wiki-check.ts')],
        { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }
      );
    expect(check()).toContain('source review passed');
    const entry = join(fixture, 'wiki/index.html');
    const original = readFileSync(entry);
    writeFileSync(entry, `${original.toString()}\n<!-- changed entrypoint -->\n`);
    expect(check).toThrow(/wiki\/index\.html/);
    writeFileSync(entry, original);
    expect(check()).toContain('source review passed');
    writeFileSync(
      join(fixture, 'src/entities/new-game-rule.ts'),
      'export const changedRule = true;\n'
    );
    expect(check).toThrow(/src\/entities\/new-game-rule\.ts/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
