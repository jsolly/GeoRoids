import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    cpSync('content', join(fixture, 'content'), { recursive: true });
    cpSync('public/wiki', join(fixture, 'public/wiki'), { recursive: true });
    symlinkSync(resolve(root, 'node_modules'), join(fixture, 'node_modules'));
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
    const prose = join(fixture, 'content/wiki/controls.md');
    writeFileSync(
      prose,
      `${readFileSync(prose, 'utf8')}\nA pilot can practice these controls before a fight.\n`
    );
    expect(check()).toContain('source review passed');
    mkdirSync(join(fixture, 'public/wiki/uploads'), { recursive: true });
    cpSync('public/wiki/media/movement.png', join(fixture, 'public/wiki/uploads/editor.png'));
    writeFileSync(
      prose,
      `${readFileSync(prose, 'utf8')}\n![A pilot practicing thrust](/wiki/uploads/editor.png)\n`
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
