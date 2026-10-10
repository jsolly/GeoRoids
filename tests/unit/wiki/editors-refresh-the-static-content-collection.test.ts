import { EventEmitter } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoaderContext } from 'astro/loaders';
import { expect, test, vi } from 'vitest';
import type { WikiArticle } from '../../../src/wiki/article';
import { wikiContentLoader } from '../../../src/wiki/contentLoader';

test('editor additions, edits and deletions refresh the collection while malformed saves preserve its last valid state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-loader-'));
  try {
    cpSync('content', join(root, 'content'), { recursive: true });
    cpSync('public/wiki', join(root, 'public/wiki'), { recursive: true });
    const entries = new Map<string, WikiArticle>();
    const watcher = new EventEmitter();
    const report = vi.fn();
    const context = {
      logger: { error: report },
      config: { root: pathToFileURL(`${root}/`) },
      store: {
        clear: () => entries.clear(),
        set: (entry: { id: string; data: WikiArticle }) => entries.set(entry.id, entry.data),
      },
      generateDigest: (data: unknown) => JSON.stringify(data),
      watcher: Object.assign(watcher, { add: () => {} }),
    } as unknown as LoaderContext;
    await wikiContentLoader().load(context);
    expect(entries.get('controls')?.title).toBe('Controls');
    const path = join(root, 'content/wiki/practice.md');
    const save = (summary: string) =>
      writeFileSync(
        path,
        `---\ntitle: Practice\ncategory: Start here\nsummary: ${summary}\norder: 200\nrelated: [content/wiki/controls.md]\n---\n## First flight\n\nTry thrust.\n`
      );
    save('Practice flight.');
    watcher.emit('all', 'add', path);
    expect(entries.get('practice')?.summary).toBe('Practice flight.');
    save('Practice a turn.');
    watcher.emit('all', 'change', path);
    expect(entries.get('practice')?.summary).toBe('Practice a turn.');
    writeFileSync(path, '---\ntitle: Broken\n---\nNo valid metadata.');
    watcher.emit('all', 'change', path);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('Wiki content refresh failed:'));
    expect(entries.get('practice')?.summary).toBe('Practice a turn.');
    rmSync(path);
    watcher.emit('all', 'unlink', path);
    expect(entries.has('practice')).toBe(false);
    // Changes to reference inputs cause a real recompile, including validation.
    save('Reference refresh.');
    mkdirSync(join(root, 'shared'), { recursive: true });
    watcher.emit('all', 'change', join(root, 'shared/world.ts'));
    expect(entries.get('practice')?.summary).toBe('Reference refresh.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
