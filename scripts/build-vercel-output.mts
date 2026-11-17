import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function contentHash(bytes: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface OutputRoute {
  src?: string;
  headers?: Record<string, string>;
  continue?: boolean;
  dest?: string;
  handle?: 'filesystem';
}

/** Emit the provider's shared immutable registry, preserving ordinary local dist. */
interface BuildOutputOptions {
  root?: string;
}

export async function buildVercelOutput({
  root = process.cwd(),
}: BuildOutputOptions = {}): Promise<{ immutableFiles: number }> {
  const output = join(root, '.vercel/output');
  await rm(output, { recursive: true, force: true });
  const staticRoot = join(output, 'static');
  await cp(join(root, 'dist'), staticRoot, { recursive: true, errorOnExist: true });
  const hashes: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Immutable output must not contain symlinks');
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), path);
      } else {
        assert(entry.isFile(), 'Immutable output is not a file');
        assert.match(path, /^\/_vercel\/immutable\/[a-f0-9]{24}\/[a-zA-Z0-9_.-]+\.(?:js|css)$/u);
        hashes[path] = contentHash(await readFile(join(directory, entry.name)));
      }
    }
  }
  await walk(join(staticRoot, '_vercel/immutable'), '/_vercel/immutable');
  assert(Object.keys(hashes).length > 0, 'Immutable client output is empty');
  const routes: OutputRoute[] = [
    {
      src: '^/(?:release|client-assets|immutable-assets)\\.json$',
      headers: { 'Cache-Control': 'no-store' },
      continue: true,
    },
    {
      src: '^/debug(?:/.*)?$',
      headers: { 'X-Robots-Tag': 'noindex, nofollow' },
      continue: true,
    },
    {
      src: '^/(?:debug/?|wiki/?)?$',
      headers: {
        Link: '<https://context7.com/api/v2/ask?siteKey=ask_10533b7684feb0762503b0e7>; rel="search"; type="text/plain"; title="Search georoids.com"',
      },
      continue: true,
    },
  ];
  routes.push(
    { src: '^/$', dest: '/index.html' },
    { src: '^/(debug|wiki)/?$', dest: '/$1/index.html' },
    { handle: 'filesystem' }
  );
  await writeFile(
    join(output, 'config.json'),
    `${JSON.stringify({ version: 3, routes }, null, 2)}\n`
  );
  const immutableManifest = `${JSON.stringify({ version: 1, hashes }, null, 2)}\n`;
  await writeFile(join(output, 'immutable.json'), immutableManifest);
  // This complete emitted inventory lets production verification prove omission,
  // rather than confusing an unreferenced file with an absent file.
  await writeFile(join(staticRoot, 'immutable-assets.json'), immutableManifest);
  return { immutableFiles: Object.keys(hashes).length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await buildVercelOutput();
  process.stdout.write(`Vercel output: ${result.immutableFiles} immutable files\n`);
}
