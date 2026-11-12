import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { expect, test } from 'vitest';
import { checkWiki } from '../../../scripts/wiki-check';
import { wikiSourceDigest } from '../../../scripts/wiki-source-digest';

const WIKI_INDEX_ENTRYPOINT_PATTERN = /src\/pages\/wiki\.astro/u;
const NEW_GAME_RULE_PATH_PATTERN = /src\/entities\/new-game-rule\.ts/u;

test('a changed wiki entrypoint or newly added game rule requires a new documentation review', async () => {
  const root = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-review-'));
  const baseline: unknown = JSON.parse(readFileSync('docs/wiki-source-review.json', 'utf8'));
  if (
    baseline === null ||
    typeof baseline !== 'object' ||
    !('hashes' in baseline) ||
    !baseline.hashes ||
    typeof baseline.hashes !== 'object'
  ) {
    throw new Error('Wiki source review must exist before testing its invalidation');
  }
  try {
    // All scenarios use the real checker and formatter on disposable files.
    // Exercise the CLI boundary explicitly without starting its full module graph
    // again for every source mutation. Include uncited transitive client imports.
    cpSync('src', join(fixture, 'src'), { recursive: true });
    cpSync('content', join(fixture, 'content'), { recursive: true });
    cpSync('public/wiki', join(fixture, 'public/wiki'), { recursive: true });
    mkdirSync(join(fixture, 'config/quality'), { recursive: true });
    cpSync(
      'config/quality/biome.settings.jsonc',
      join(fixture, 'config/quality/biome.settings.jsonc')
    );
    symlinkSync(resolve(root, 'node_modules'), join(fixture, 'node_modules'));
    for (const path of [...Object.keys(baseline.hashes), 'docs/wiki-source-review.json']) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(path)) {
        cpSync(path, target);
      }
    }
    const hashes = Object.fromEntries(
      Object.keys(baseline.hashes)
        .filter((path) => existsSync(join(fixture, path)))
        .map((path) => [path, wikiSourceDigest(path, readFileSync(join(fixture, path)))])
    );
    const reviewPath = join(fixture, 'docs/wiki-source-review.json');
    writeFileSync(
      reviewPath,
      JSON.stringify({
        note: 'Existing review',
        hashes,
        reviews: [{ note: 'Previous batch' }],
      })
    );
    const cliCheck = (...args: string[]): string =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', join(fixture, 'scripts/wiki-check.ts'), ...args],
        { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }
      );
    const check = async (...args: string[]): Promise<string> => {
      const result = await checkWiki({ root: fixture, args });
      if (result.exitCode !== 0) {
        throw new Error(result.output);
      }
      return result.output;
    };
    expect(cliCheck()).toContain('source review passed');
    expect(() => cliCheck('--unknown')).toThrow('Invalid Wiki review argument');
    const prose = join(fixture, 'content/wiki/controls.md');
    writeFileSync(
      prose,
      `${readFileSync(prose, 'utf8')}\nA pilot can practice these controls before a fight.\n`
    );
    expect(await check()).toContain('source review passed');
    mkdirSync(join(fixture, 'public/wiki/uploads'), { recursive: true });
    cpSync('public/wiki/media/movement.png', join(fixture, 'public/wiki/uploads/editor.png'));
    writeFileSync(
      prose,
      `${readFileSync(prose, 'utf8')}\n![A pilot practicing thrust](/wiki/uploads/editor.png)\n`
    );
    expect(await check()).toContain('source review passed');
    const entry = join(fixture, 'src/pages/wiki.astro');
    const original = readFileSync(entry);
    writeFileSync(entry, `${original.toString()}\n<!-- changed entrypoint -->\n`);
    expect(cliCheck).toThrow(WIKI_INDEX_ENTRYPOINT_PATTERN);
    writeFileSync(entry, original);
    expect(await check()).toContain('source review passed');
    const otherEntry = 'src/pages/index.astro';
    const otherOriginal = readFileSync(join(fixture, otherEntry));
    writeFileSync(entry, `${original.toString()}\n<!-- first source review -->\n`);
    writeFileSync(
      join(fixture, otherEntry),
      `${otherOriginal.toString()}\n<!-- second source review -->\n`
    );
    const oldEntryHash = hashes[otherEntry];
    cliCheck(
      '--accept',
      '--note',
      'Reviewed first entry',
      '--source',
      'src/pages/wiki.astro',
      '--topic',
      'field-manual',
      '--owner',
      'src/pages/wiki.astro=field-manual'
    );
    expect(JSON.parse(readFileSync(reviewPath, 'utf8')).hashes[otherEntry]).toBe(oldEntryHash);
    execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/@biomejs/biome/bin/biome'),
        'check',
        `--config-path=${join(fixture, 'config/quality/biome.settings.jsonc')}`,
        '--vcs-enabled=false',
        '--error-on-warnings',
        reviewPath,
      ],
      { cwd: fixture, stdio: 'pipe' }
    );
    const beforeFormatterFailure = readFileSync(reviewPath, 'utf8');
    const formatterConfig = join(fixture, 'config/quality/biome.settings.jsonc');
    const originalConfig = readFileSync(formatterConfig);
    try {
      writeFileSync(formatterConfig, '{ invalid formatter config');
      expect(() =>
        cliCheck(
          '--accept',
          '--source',
          otherEntry,
          '--topic',
          'field-manual',
          '--owner',
          `${otherEntry}=field-manual`,
          '--note',
          'Reviewed formatter failure'
        )
      ).toThrow(/biome/u);
      expect(readFileSync(reviewPath, 'utf8')).toBe(beforeFormatterFailure);
    } finally {
      writeFileSync(formatterConfig, originalConfig);
    }
    await expect(check()).rejects.toThrow(/index\.astro/u);
    await check(
      '--accept',
      '--note',
      'Reviewed second entry',
      '--source',
      otherEntry,
      '--topic',
      'field-manual',
      '--owner',
      `${otherEntry}=field-manual`
    );
    expect(await check()).toContain('source review passed');
    writeFileSync(
      join(fixture, 'src/entities/new-game-rule.ts'),
      'export const changedRule = true;\n'
    );
    await expect(check()).rejects.toThrow(NEW_GAME_RULE_PATH_PATTERN);
    const added = 'src/entities/new-game-rule.ts';
    const second = 'src/entities/second-game-rule.ts';
    writeFileSync(join(fixture, second), 'export const secondRule = true;\n');
    const accept = (...selectors: string[]): Promise<string> =>
      check('--accept', '--note', 'Reviewed rules', ...selectors);
    const before = readFileSync(reviewPath, 'utf8');
    for (const selectors of [
      [],
      ['--source', added, '--topic', 'controls'],
      ['--source', added, '--topic', 'missing', '--owner', `${added}=missing`],
      [
        '--source',
        added,
        '--topic',
        'controls',
        '--owner',
        `${added}=controls`,
        '--media',
        'missing',
      ],
      ['--source', '../escape', '--topic', 'controls'],
      ['--source', added, '--source', added, '--topic', 'controls'],
      ['--source', added, '--topic', 'controls', '--owner', 'malformed'],
    ]) {
      await expect(accept(...selectors)).rejects.toThrow();
      expect(readFileSync(reviewPath, 'utf8')).toBe(before);
    }
    for (const inheritedId of ['constructor', '__proto__']) {
      await expect(
        accept(
          '--source',
          added,
          '--topic',
          'controls',
          '--owner',
          `${added}=controls`,
          '--media',
          inheritedId
        )
      ).rejects.toThrow(`Unknown media: ${inheritedId}`);
      expect(readFileSync(reviewPath, 'utf8')).toBe(before);
    }
    expect(
      await accept('--source', added, '--topic', 'controls', '--owner', `${added}=controls`)
    ).toContain('1 pending sources');
    const acceptedOne = JSON.parse(readFileSync(reviewPath, 'utf8'));
    expect(acceptedOne.note).toBe('Existing review');
    expect(acceptedOne.reviews[0]).toEqual({ note: 'Previous batch' });
    expect(acceptedOne.hashes[second]).toBeUndefined();
    const afterOne = readFileSync(reviewPath, 'utf8');
    await expect(check()).rejects.toThrow(/second-game-rule/u);
    expect(readFileSync(reviewPath, 'utf8')).toBe(afterOne);
    await accept('--source', second, '--topic', 'controls', '--owner', `${second}=controls`);
    expect(await check()).toContain('source review passed');
    rmSync(join(fixture, added));
    const beforeDeletion = readFileSync(reviewPath, 'utf8');
    await expect(accept('--source', added, '--topic', 'controls')).rejects.toThrow(
      /requires --owner/u
    );
    expect(readFileSync(reviewPath, 'utf8')).toBe(beforeDeletion);
    await accept('--source', added, '--topic', 'controls', '--owner', `${added}=controls`);
    expect(JSON.parse(readFileSync(reviewPath, 'utf8')).hashes[added]).toBeUndefined();
    expect(await check()).toContain('source review passed');
    // Gameplay and published interfaces invalidate on addition, edit and deletion.
    for (const path of [
      'src/runtime/review-fixture.ts',
      'src/components/GameDocument.astro',
      'src/components/wiki/ReviewFixture.svelte',
      'src/pages/review-fixture.astro',
      'scripts/client-build.ts',
    ]) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true });
      const originalSource = existsSync(target) ? readFileSync(target) : undefined;
      writeFileSync(target, '/* first reviewed source */\n');
      await expect(check()).rejects.toThrow(path);
      await accept('--source', path, '--topic', 'field-manual', '--owner', `${path}=field-manual`);
      writeFileSync(target, '/* second reviewed source */\n');
      await expect(check()).rejects.toThrow(path);
      await accept('--source', path, '--topic', 'field-manual', '--owner', `${path}=field-manual`);
      rmSync(target);
      await expect(check()).rejects.toThrow(path);
      await expect(accept('--source', path, '--topic', 'field-manual')).rejects.toThrow(
        /requires --owner/u
      );
      await accept('--source', path, '--topic', 'field-manual', '--owner', `${path}=field-manual`);
      if (originalSource !== undefined) {
        writeFileSync(target, originalSource);
        await accept(
          '--source',
          path,
          '--topic',
          'field-manual',
          '--owner',
          `${path}=field-manual`
        );
      }
      expect(await check()).toContain('source review passed');
    }
    // These maintenance surfaces remain visible but need no acceptance or ledger write.
    for (const path of [
      'src/diagnostics/review-fixture.ts',
      'src/release/review-fixture.ts',
      'src/styles/review-fixture.css',
      'src/components/ui/ReviewFixture.svelte',
      'src/entities/review-fixture.css',
      'config/app/astro.ts',
      'config/app/svelte.ts',
      'config/quality/prettier.json',
      'config/typescript/frontend.json',
      'config/typescript/tsconfig.json',
      'tsconfig.json',
    ]) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true });
      const originalSource = existsSync(target) ? readFileSync(target) : undefined;
      const beforeAdvisory = readFileSync(reviewPath, 'utf8');
      writeFileSync(target, '/* first maintenance edit */\n');
      expect(await check()).toContain('source review passed');
      expect(await check()).toContain(path);
      writeFileSync(target, '/* second maintenance edit */\n');
      expect(await check()).toContain(path);
      expect(readFileSync(reviewPath, 'utf8')).toBe(beforeAdvisory);
      // A previously inventoried maintenance file can be removed without a note.
      const ledger = JSON.parse(beforeAdvisory);
      ledger.hashes[path] = wikiSourceDigest(path, readFileSync(target));
      writeFileSync(reviewPath, JSON.stringify(ledger));
      rmSync(target);
      expect(await check()).toContain('source review passed');
      expect(await check()).toContain(path);
      expect(JSON.parse(readFileSync(reviewPath, 'utf8')).hashes[path]).toBe(ledger.hashes[path]);
      writeFileSync(reviewPath, beforeAdvisory);
      if (originalSource !== undefined) {
        writeFileSync(target, originalSource);
      }
    }
    // A declared diagnostics or CSS source still controls documented behavior.
    for (const path of ['src/diagnostics/debugHudMetrics.ts', 'index.css']) {
      const target = join(fixture, path);
      const originalSource = readFileSync(target);
      writeFileSync(target, `${originalSource.toString()}\n/* changed documented behavior */\n`);
      await expect(check()).rejects.toThrow(path);
      writeFileSync(target, originalSource);
      expect(await check()).toContain('source review passed');
    }
    const mapped = 'src/input/keybindings.ts';
    writeFileSync(
      join(fixture, mapped),
      `${readFileSync(join(fixture, mapped), 'utf8')}\n// reviewed change\n`
    );
    const beforeMapped = readFileSync(reviewPath, 'utf8');
    await expect(accept('--source', mapped, '--topic', 'field-manual')).rejects.toThrow(
      /missing affected --topic controls/u
    );
    expect(readFileSync(reviewPath, 'utf8')).toBe(beforeMapped);
    await accept('--source', mapped, '--topic', 'controls');
    const image = 'public/wiki/media/movement.gif';
    writeFileSync(
      join(fixture, image),
      Buffer.concat([readFileSync(join(fixture, image)), Buffer.from('review')])
    );
    const beforeMedia = readFileSync(reviewPath, 'utf8');
    await expect(accept('--source', image, '--topic', 'controls')).rejects.toThrow(
      /missing affected --media movement/u
    );
    expect(readFileSync(reviewPath, 'utf8')).toBe(beforeMedia);
    await accept('--source', image, '--topic', 'controls', '--media', 'movement');
    expect(cliCheck()).toContain('source review passed');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
