// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { expect, test } from 'vitest';
import { collectLiveReportMetadata } from '../../../benchmarks/live-report';

test('mobile sessions detect changed Wiki, build scripts and inherited compiler inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-live-inputs-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: environment, stdio: 'pipe' });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const fixtures = [
    { path: 'src/pages/wiki.astro', scope: 'productSha256' },
    { path: 'src/components/wiki/WikiShell.svelte', scope: 'productSha256' },
    { path: 'src/styles/theme.css', scope: 'productSha256' },
    { path: 'astro.config.ts', scope: 'harnessSha256' },
    { path: 'svelte.config.js', scope: 'harnessSha256' },
    { path: 'components.json', scope: 'harnessSha256' },
    { path: 'content/wiki/hud-network.md', scope: 'productSha256' },
    { path: 'docs/wiki-source-review.json', scope: 'productSha256' },
    { path: 'scripts/wiki-content.ts', scope: 'harnessSha256' },
    { path: 'src/wiki/contentLoader.ts', scope: 'harnessSha256' },
    { path: 'scripts/wiki-check.ts', scope: 'harnessSha256' },
    { path: 'scripts/benchmark-build-receipt.mjs', scope: 'harnessSha256' },
    { path: 'tsconfig/fleet/strict-tsc.json', scope: 'harnessSha256' },
  ] as const;
  try {
    git('init', '-q');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture'
    );
    write('.gitignore', 'dist/\n');
    write('package-lock.json', '{}');
    write('dist/index.html', 'frozen production assets');
    for (const { path } of fixtures) {
      write(path, 'original');
    }
    git('add', '.');
    const baseline = collectLiveReportMetadata({ root }).git;
    expect(collectLiveReportMetadata({ root }).git).toEqual(baseline);
    for (const { path, scope } of fixtures) {
      write(path, 'changed during measurement');
      const changed = collectLiveReportMetadata({ root }).git;
      expect(changed.sourceSha256, path).not.toBe(baseline.sourceSha256);
      expect(changed[scope], path).not.toBe(baseline[scope]);
      expect(changed.buildSha256).toBe(baseline.buildSha256);
      expect(changed.lockfileSha256).toBe(baseline.lockfileSha256);
      write(path, 'original');
      expect(collectLiveReportMetadata({ root }).git).toEqual(baseline);
      rmSync(join(root, path));
      expect(collectLiveReportMetadata({ root }).git[scope], path).not.toBe(baseline[scope]);
      write(path, 'original');
      expect(collectLiveReportMetadata({ root }).git).toEqual(baseline);
    }
    rmSync(join(root, 'scripts/wiki-content.ts'));
    expect(collectLiveReportMetadata({ root }).git.sourceSha256).not.toBe(baseline.sourceSha256);
    write('scripts/wiki-content.ts', 'original');
    write('scripts/new-build-input.ts', 'new untracked build input');
    expect(collectLiveReportMetadata({ root }).git.harnessSha256).not.toBe(baseline.harnessSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
