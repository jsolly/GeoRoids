import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const WIKI_INDEX_ENTRYPOINT_PATTERN = /wiki\/index\.html/u;
const NEW_GAME_RULE_PATH_PATTERN = /src\/entities\/new-game-rule\.ts/u;

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
      if (existsSync(path)) {
        cpSync(path, target);
      }
    }
    const hashes = Object.fromEntries(
      Object.keys(baseline.hashes)
        .filter((path) => existsSync(join(fixture, path)))
        .map((path) => [
          path,
          `sha256:${createHash('sha256')
            .update(readFileSync(join(fixture, path)))
            .digest('hex')}`,
        ])
    );
    const reviewPath = join(fixture, 'docs/wiki-source-review.json');
    writeFileSync(
      reviewPath,
      JSON.stringify({ note: 'Existing review', hashes, reviews: [{ note: 'Previous batch' }] })
    );
    const check = (...args: string[]): string =>
      execFileSync(
        process.execPath,
        [
          resolve(root, 'node_modules/tsx/dist/cli.mjs'),
          join(fixture, 'scripts/wiki-check.ts'),
          ...args,
        ],
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
    expect(check).toThrow(WIKI_INDEX_ENTRYPOINT_PATTERN);
    writeFileSync(entry, original);
    expect(check()).toContain('source review passed');
    const otherEntry = 'index.html';
    const otherOriginal = readFileSync(join(fixture, otherEntry));
    writeFileSync(entry, `${original.toString()}\n<!-- first source review -->\n`);
    writeFileSync(
      join(fixture, otherEntry),
      `${otherOriginal.toString()}\n<!-- second source review -->\n`
    );
    const oldEntryHash = hashes[otherEntry];
    check(
      '--accept',
      '--note',
      'Reviewed first entry',
      '--source',
      'wiki/index.html',
      '--topic',
      'field-manual',
      '--owner',
      'wiki/index.html=field-manual'
    );
    expect(JSON.parse(readFileSync(reviewPath, 'utf8')).hashes[otherEntry]).toBe(oldEntryHash);
    expect(() => check()).toThrow(/index\.html/u);
    check(
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
    expect(check()).toContain('source review passed');
    writeFileSync(
      join(fixture, 'src/entities/new-game-rule.ts'),
      'export const changedRule = true;\n'
    );
    expect(check).toThrow(NEW_GAME_RULE_PATH_PATTERN);
    const added = 'src/entities/new-game-rule.ts';
    const second = 'src/entities/second-game-rule.ts';
    writeFileSync(join(fixture, second), 'export const secondRule = true;\n');
    const accept = (...selectors: string[]): string =>
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
      expect(() => accept(...selectors)).toThrow();
      expect(readFileSync(reviewPath, 'utf8')).toBe(before);
    }
    for (const inheritedId of ['constructor', '__proto__']) {
      expect(() =>
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
      ).toThrow(`Unknown media: ${inheritedId}`);
      expect(readFileSync(reviewPath, 'utf8')).toBe(before);
    }
    expect(
      accept('--source', added, '--topic', 'controls', '--owner', `${added}=controls`)
    ).toContain('1 pending sources');
    const acceptedOne = JSON.parse(readFileSync(reviewPath, 'utf8'));
    expect(acceptedOne.note).toBe('Existing review');
    expect(acceptedOne.reviews[0]).toEqual({ note: 'Previous batch' });
    expect(acceptedOne.hashes[second]).toBeUndefined();
    const afterOne = readFileSync(reviewPath, 'utf8');
    expect(() => check()).toThrow(/second-game-rule/u);
    expect(readFileSync(reviewPath, 'utf8')).toBe(afterOne);
    accept('--source', second, '--topic', 'controls', '--owner', `${second}=controls`);
    expect(check()).toContain('source review passed');
    rmSync(join(fixture, added));
    const beforeDeletion = readFileSync(reviewPath, 'utf8');
    expect(() => accept('--source', added, '--topic', 'controls')).toThrow(/requires --owner/u);
    expect(readFileSync(reviewPath, 'utf8')).toBe(beforeDeletion);
    accept('--source', added, '--topic', 'controls', '--owner', `${added}=controls`);
    expect(JSON.parse(readFileSync(reviewPath, 'utf8')).hashes[added]).toBeUndefined();
    expect(check()).toContain('source review passed');
    const mapped = 'src/input/keybindings.ts';
    writeFileSync(
      join(fixture, mapped),
      `${readFileSync(join(fixture, mapped), 'utf8')}\n// reviewed change\n`
    );
    const beforeMapped = readFileSync(reviewPath, 'utf8');
    expect(() => accept('--source', mapped, '--topic', 'field-manual')).toThrow(
      /missing affected --topic controls/u
    );
    expect(readFileSync(reviewPath, 'utf8')).toBe(beforeMapped);
    accept('--source', mapped, '--topic', 'controls');
    const image = 'public/wiki/media/movement.gif';
    writeFileSync(
      join(fixture, image),
      Buffer.concat([readFileSync(join(fixture, image)), Buffer.from('review')])
    );
    const beforeMedia = readFileSync(reviewPath, 'utf8');
    expect(() => accept('--source', image, '--topic', 'controls')).toThrow(
      /missing affected --media movement/u
    );
    expect(readFileSync(reviewPath, 'utf8')).toBe(beforeMedia);
    accept('--source', image, '--topic', 'controls', '--media', 'movement');
    expect(check()).toContain('source review passed');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
