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
import { wikiSourceDigest } from '../../../scripts/wiki-source-digest';

const PACKAGE_REVIEW_PATTERN =
  /Wiki review needed for 1 changed sources\/assets:\n {2}package\.json\n/u;

type Manifest = Record<string, unknown> & {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides: Record<string, unknown>;
};

test('dependency version bumps skip the Wiki review while other manifest changes still require it', () => {
  const root = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-dependencies-'));
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
    // Run the real CLI against a disposable copy so the committed review is untouched.
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
    const check = (...args: string[]): string =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', join(fixture, 'scripts/wiki-check.ts'), ...args],
        { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }
      );
    const hashes = Object.fromEntries(
      Object.keys(baseline.hashes)
        .filter((path) => existsSync(join(fixture, path)))
        .map((path) => [path, wikiSourceDigest(path, readFileSync(join(fixture, path)))])
    );
    writeFileSync(
      join(fixture, 'docs/wiki-source-review.json'),
      JSON.stringify({ note: 'Existing review', hashes })
    );
    const manifestPath = join(fixture, 'package.json');
    const original = readFileSync(manifestPath, 'utf8');
    expect(check()).toContain('source review passed');
    const edit = (change: (manifest: Manifest) => void): void => {
      const manifest = JSON.parse(original) as Manifest;
      change(manifest);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const [dependency] = Object.keys(JSON.parse(original).dependencies as object);
    const [devDependency] = Object.keys(JSON.parse(original).devDependencies as object);
    if (dependency === undefined || devDependency === undefined) {
      throw new Error('The manifest must declare dependencies and devDependencies');
    }

    // Version-only bumps across every dependency section, including nested overrides.
    edit((manifest) => {
      manifest.dependencies[dependency] = '99.0.0';
      manifest.devDependencies[devDependency] = '^99.1.0';
      manifest.overrides = Object.fromEntries(
        Object.entries(manifest.overrides).map(([name, value]) => [
          name,
          typeof value === 'string'
            ? '>=99.0.0'
            : Object.fromEntries(Object.keys(value as object).map((key) => [key, '99.0.0'])),
        ])
      );
    });
    expect(check()).toContain('source review passed');

    // Scripts, engines and other fields still invalidate the review.
    for (const change of [
      (manifest: Manifest) => {
        manifest.scripts['check:wiki'] = 'true';
      },
      (manifest: Manifest) => {
        manifest['engines'] = { node: '^26.0.0' };
      },
      (manifest: Manifest) => {
        manifest['name'] = 'renamed-georoids';
      },
    ]) {
      edit(change);
      expect(check).toThrow(PACKAGE_REVIEW_PATTERN);
    }

    // Adding, removing or moving a package changes what ships, so it still needs review.
    for (const change of [
      (manifest: Manifest) => {
        manifest.dependencies['left-pad'] = '1.3.0';
      },
      (manifest: Manifest) => {
        delete manifest.devDependencies[devDependency];
      },
      (manifest: Manifest) => {
        const version = manifest.devDependencies[devDependency] ?? '';
        delete manifest.devDependencies[devDependency];
        manifest.dependencies[devDependency] = version;
      },
    ]) {
      edit(change);
      expect(check).toThrow(PACKAGE_REVIEW_PATTERN);
    }

    writeFileSync(manifestPath, original);
    expect(check()).toContain('source review passed');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the package digest ignores only dependency version strings', () => {
  const digest = (value: unknown): string =>
    wikiSourceDigest('package.json', Buffer.from(JSON.stringify(value)));
  const manifest = {
    scripts: { build: 'astro build' },
    optionalDependencies: { fsevents: '2.3.3' },
    peerDependencies: { svelte: '^5.0.0' },
  };
  expect(
    digest({
      ...manifest,
      optionalDependencies: { fsevents: '2.3.4' },
      peerDependencies: { svelte: '^6.0.0' },
    })
  ).toBe(digest(manifest));
  expect(digest({ ...manifest, scripts: { build: 'astro build --verbose' } })).not.toBe(
    digest(manifest)
  );
  expect(digest({ ...manifest, peerDependencies: { astro: '^5.0.0' } })).not.toBe(digest(manifest));
  // Other files and a malformed manifest keep the plain byte digest.
  expect(wikiSourceDigest('index.css', Buffer.from('a'))).not.toBe(
    wikiSourceDigest('index.css', Buffer.from('b'))
  );
  expect(wikiSourceDigest('package.json', Buffer.from('{"version": "1"'))).not.toBe(
    wikiSourceDigest('package.json', Buffer.from('{"version": "2"'))
  );
});
