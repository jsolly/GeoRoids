// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import {
  assertWorkflowContext,
  isAllowedWikiPath,
  parseGitNameStatus,
  parseGitTree,
  parsePagesCmsPayload,
  snapshotBranchName,
  validateChangedPaths,
  validateWikiTree,
} from '../../../scripts/wiki-publish.mjs';

const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';
const GIT_PATH_ENVIRONMENT = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

function gitEnvironment() {
  const environment = { ...process.env };
  for (const name of GIT_PATH_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment(),
  });
}

function gitSucceeds(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function commit(cwd, message) {
  git(cwd, ['add', '--all']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function materializeInFixture(cwd, parent, main, overlay, options = {}) {
  const moduleUrl = pathToFileURL(resolve('scripts/wiki-publish.mjs')).href;
  const code = [
    `import { materializeCombinedTree } from ${JSON.stringify(moduleUrl)};`,
    `process.chdir(${JSON.stringify(cwd)});`,
    `process.stdout.write(materializeCombinedTree(${JSON.stringify(parent)}, ${JSON.stringify(main)}, ${JSON.stringify(overlay)}, ${JSON.stringify(options)}));`,
  ].join('\n');
  try {
    return execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    throw new Error(error.stderr?.toString() || error.message);
  }
}

function snapshotMatchesInFixture(cwd, snapshot, main, source) {
  const moduleUrl = pathToFileURL(resolve('scripts/wiki-publish.mjs')).href;
  const code = [
    `import { existingSnapshotMatches } from ${JSON.stringify(moduleUrl)};`,
    `process.chdir(${JSON.stringify(cwd)});`,
    `process.stdout.write(String(existingSnapshotMatches(${JSON.stringify(snapshot)}, ${JSON.stringify(main)}, ${JSON.stringify(source)})));`,
  ].join('\n');
  return execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

test('the Pages CMS payload validates the draft ref and workflow SHA', () => {
  const parsed = parsePagesCmsPayload(
    JSON.stringify({
      source: 'pages-cms',
      action: { name: 'publish-wiki' },
      repository: {
        owner: 'jsolly',
        repo: 'GeoRoids',
        ref: 'refs/heads/codex/wiki-drafts',
        sha: SOURCE_SHA,
        workflowRef: 'main',
      },
      context: { type: 'collection', path: 'content/wiki' },
    })
  );

  expect(parsed.sourceRef).toBe('codex/wiki-drafts');
  expect(parsed.workflowSha).toBe(SOURCE_SHA);
  expect(() =>
    assertWorkflowContext(parsed, {
      eventRef: 'refs/heads/main',
      repositoryName: 'jsolly/georoids',
    })
  ).not.toThrow();
  expect(() =>
    assertWorkflowContext(parsed, {
      eventRef: 'refs/heads/main',
      repositoryName: 'other/georoids',
    })
  ).toThrow(/does not match this workflow repository/);
  expect(() =>
    parsePagesCmsPayload(
      JSON.stringify({
        source: 'pages-cms',
        action: { name: 'publish-wiki' },
        repository: { ref: 'codex/wiki-drafts', sha: '0123456' },
      })
    )
  ).toThrow(/full 40-character/);
  expect(() =>
    parsePagesCmsPayload(
      JSON.stringify({
        source: 'pages-cms',
        action: { name: 'publish-wiki' },
        repository: { ref: 'main', sha: SOURCE_SHA },
      })
    )
  ).toThrow(/source ref/);
});

test('the path boundary permits only Markdown and safe raster uploads', () => {
  expect(isAllowedWikiPath('content/wiki/field-manual.md')).toBe(true);
  expect(isAllowedWikiPath('public/wiki/uploads/screenshots/mobile.webp')).toBe(true);
  expect(isAllowedWikiPath('public/wiki/uploads/screenshots/mobile.svg')).toBe(false);
  expect(isAllowedWikiPath('src/wiki/main.ts')).toBe(false);
  expect(isAllowedWikiPath('content/wiki/../package.json')).toBe(false);
  expect(() =>
    validateChangedPaths([
      { status: 'M', path: 'content/wiki/field-manual.md' },
      { status: 'A', path: 'src/wiki/main.ts' },
    ])
  ).toThrow(/outside the wiki publish scope/);
});

test('tree validation rejects symlinks and executable or non-raster files', () => {
  const valid = parseGitTree('100644 blob abcdef\tcontent/wiki/field-manual.md\0');
  expect(validateWikiTree(valid)).toEqual(valid);
  expect(() =>
    validateWikiTree(parseGitTree('120000 blob abcdef\tpublic/wiki/uploads/current.webp\0'))
  ).toThrow(/invalid file/);
  expect(() =>
    validateWikiTree(parseGitTree('100755 blob abcdef\tcontent/wiki/field-manual.md\0'))
  ).toThrow(/invalid file/);
});

test('the immutable snapshot identity is stable across retries', () => {
  expect(snapshotBranchName(SOURCE_SHA)).toBe(`codex/wiki-publish/${SOURCE_SHA}`);
  expect(snapshotBranchName(SOURCE_SHA)).toBe(snapshotBranchName(SOURCE_SHA));
  expect(() => snapshotBranchName('0123456')).toThrow(/full draft SHA/);
});

test('a squash merge plus a newer same-file draft edit stays conflict-free and preserves both snapshots', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-publish-'));
  try {
    git(fixture, ['init', '--initial-branch', 'main']);
    git(fixture, ['config', 'user.name', 'fixture']);
    git(fixture, ['config', 'user.email', 'fixture@example.test']);
    mkdirSync(join(fixture, 'content', 'wiki'), { recursive: true });
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'base\n');
    writeFileSync(join(fixture, 'content', 'wiki', 'other.md'), 'other base\n');
    const base = commit(fixture, 'base');

    git(fixture, ['switch', '--create', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'published v1\n');
    const firstDraft = commit(fixture, 'editor: publish v1');

    git(fixture, ['switch', 'main']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'published v1\n');
    writeFileSync(join(fixture, 'content', 'wiki', 'other.md'), 'developer update\n');
    const squashedMain = commit(
      fixture,
      `squash: publish v1\n\nGeoRoids wiki draft snapshot: ${firstDraft}`
    );

    git(fixture, ['switch', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'editor v2\n');
    const newerDraft = commit(fixture, 'editor: change the same article');

    expect(gitSucceeds(fixture, ['merge-base', '--is-ancestor', firstDraft, newerDraft])).toBe(
      true
    );
    expect(gitSucceeds(fixture, ['merge-base', '--is-ancestor', squashedMain, newerDraft])).toBe(
      false
    );

    const refreshedDraft = materializeInFixture(fixture, newerDraft, squashedMain, newerDraft);
    expect(git(fixture, ['show', `${refreshedDraft}:content/wiki/article.md`])).toBe('editor v2\n');
    expect(git(fixture, ['show', `${refreshedDraft}:content/wiki/other.md`])).toBe(
      'developer update\n'
    );
    expect(git(fixture, ['show', '-s', '--format=%P', refreshedDraft]).trim().split(/\s+/)).toEqual(
      expect.arrayContaining([newerDraft, squashedMain])
    );

    const exactFirstSnapshot = materializeInFixture(fixture, firstDraft, squashedMain, firstDraft);
    expect(git(fixture, ['show', `${exactFirstSnapshot}:content/wiki/article.md`])).toBe(
      'published v1\n'
    );
    expect(git(fixture, ['show', `${base}:content/wiki/article.md`])).toBe('base\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('Git name-status parsing keeps paths with spaces intact', () => {
  expect(parseGitNameStatus('M\0content/wiki/a long title.md\0')).toEqual([
    { status: 'M', path: 'content/wiki/a long title.md' },
  ]);
});

test('the snapshot normalizes CMS Markdown that omits its final newline', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-publish-normalize-'));
  try {
    git(fixture, ['init', '--initial-branch', 'main']);
    git(fixture, ['config', 'user.name', 'fixture']);
    git(fixture, ['config', 'user.email', 'fixture@example.test']);
    mkdirSync(join(fixture, 'content', 'wiki'), { recursive: true });
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'base\n');
    commit(fixture, 'base');
    git(fixture, ['switch', '--create', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'saved from CMS');
    const draft = commit(fixture, 'editor save');
    git(fixture, ['switch', 'main']);
    const main = git(fixture, ['rev-parse', 'HEAD']).trim();

    const snapshot = materializeInFixture(fixture, draft, main, draft, {
      normalizeMarkdown: true,
    });
    expect(git(fixture, ['show', `${snapshot}:content/wiki/article.md`])).toBe('saved from CMS\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('a later CMS save stays publishable after a normalized snapshot', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-publish-retry-'));
  try {
    git(fixture, ['init', '--initial-branch', 'main']);
    git(fixture, ['config', 'user.name', 'fixture']);
    git(fixture, ['config', 'user.email', 'fixture@example.test']);
    mkdirSync(join(fixture, 'content', 'wiki'), { recursive: true });
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'base\n');
    const base = commit(fixture, 'base');
    git(fixture, ['switch', '--create', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'saved from CMS');
    const firstDraft = commit(fixture, 'editor save');
    git(fixture, ['switch', 'main']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'saved from CMS\n');
    const published = commit(
      fixture,
      `squash: publish first save\n\nGeoRoids wiki draft snapshot: ${firstDraft}`
    );
    git(fixture, ['switch', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'second CMS save');
    const secondDraft = commit(fixture, 'editor second save');

    const firstSnapshot = materializeInFixture(fixture, firstDraft, published, firstDraft, {
      normalizeMarkdown: true,
    });
    expect(snapshotMatchesInFixture(fixture, firstSnapshot, published, firstDraft)).toBe('true');
    const secondSnapshot = materializeInFixture(fixture, secondDraft, published, secondDraft, {
      normalizeMarkdown: true,
    });
    expect(git(fixture, ['show', `${secondSnapshot}:content/wiki/article.md`])).toBe(
      'second CMS save\n'
    );
    expect(git(fixture, ['show', `${base}:content/wiki/article.md`])).toBe('base\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('an independent same-file main edit stops publication instead of being overwritten', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-publish-conflict-'));
  try {
    git(fixture, ['init', '--initial-branch', 'main']);
    git(fixture, ['config', 'user.name', 'fixture']);
    git(fixture, ['config', 'user.email', 'fixture@example.test']);
    mkdirSync(join(fixture, 'content', 'wiki'), { recursive: true });
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'base\n');
    commit(fixture, 'base');
    git(fixture, ['switch', '--create', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'editor draft\n');
    const draft = commit(fixture, 'editor draft');
    git(fixture, ['switch', 'main']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'developer main\n');
    const main = commit(fixture, 'developer main edit');

    expect(() => materializeInFixture(fixture, draft, main, draft)).toThrow(
      /changed independently on main/
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('a main rollback after publication is not mistaken for an unchanged published baseline', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'georoids-wiki-publish-rollback-'));
  try {
    git(fixture, ['init', '--initial-branch', 'main']);
    git(fixture, ['config', 'user.name', 'fixture']);
    git(fixture, ['config', 'user.email', 'fixture@example.test']);
    mkdirSync(join(fixture, 'content', 'wiki'), { recursive: true });
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'base\n');
    commit(fixture, 'base');
    git(fixture, ['switch', '--create', 'codex/wiki-drafts']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'published v1\n');
    const publishedDraft = commit(fixture, 'editor publish v1');
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'editor v2\n');
    const draft = commit(fixture, 'editor v2');
    git(fixture, ['switch', 'main']);
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'published v1\n');
    const publication = commit(
      fixture,
      `squash: publish v1\n\nGeoRoids wiki draft snapshot: ${publishedDraft}`
    );
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'developer rollback\n');
    commit(fixture, 'developer change');
    writeFileSync(join(fixture, 'content', 'wiki', 'article.md'), 'base\n');
    const rollback = commit(fixture, 'developer rollback to pre-publication text');

    git(fixture, ['switch', 'codex/wiki-drafts']);
    const unchangedDraft = materializeInFixture(fixture, publishedDraft, rollback, publishedDraft);
    expect(git(fixture, ['show', `${unchangedDraft}:content/wiki/article.md`])).toBe('base\n');
    expect(() => materializeInFixture(fixture, draft, rollback, draft)).toThrow(
      /changed on main after its last published snapshot/
    );
    expect(git(fixture, ['show', '-s', '--format=%s', publication]).trim()).toBe(
      'squash: publish v1'
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
