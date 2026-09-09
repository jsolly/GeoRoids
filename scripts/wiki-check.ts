import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listShipKits } from '../src/entities/ship/shipKits';
import { articles } from '../src/wiki/content';
import { media } from '../src/wiki/media';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'docs/wiki-source-review.json');
const failures: string[] = [];
const ids = new Set(articles.map((article) => article.id));
if (ids.size !== articles.length) {
  failures.push('Duplicate article IDs');
}
for (const kit of listShipKits()) {
  const article = articles.find((entry) => entry.id === kit.id);
  if (!article) {
    failures.push(`Missing ship article: ${kit.id}`);
  } else if (!article.media.includes(kit.id)) {
    failures.push(`Missing ship ability demonstration: ${kit.id}`);
  }
}
for (const article of articles) {
  if (!/^[a-z0-9-]+$/.test(article.id)) {
    failures.push(`Invalid article ID: ${article.id}`);
  }
  if (article.sections.length === 0 || article.sources.length === 0) {
    failures.push(`Incomplete article: ${article.id}`);
  }
  for (const id of article.related) {
    if (!ids.has(id)) {
      failures.push(`${article.id}: broken related entry ${id}`);
    }
  }
  for (const id of article.media) {
    if (!media[id]) {
      failures.push(`${article.id}: missing media definition ${id}`);
    }
  }
  for (const path of article.sources) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`${article.id}: missing source ${path}`);
    }
  }
}
for (const [id, item] of Object.entries(media)) {
  if (!articles.some((article) => article.media.includes(id))) {
    failures.push(`Unreferenced demonstration: ${id}`);
  }
  if (!item.alt || !item.caption || !item.sources.length) {
    failures.push(`Incomplete demonstration: ${id}`);
  }
  for (const path of item.sources) {
    if (!existsSync(resolve(root, path))) {
      failures.push(`${id}: missing media source ${path}`);
    }
  }
  for (const extension of ['gif', 'png']) {
    const path = resolve(root, `public/wiki/media/${id}.${extension}`);
    if (!existsSync(path)) {
      failures.push(`Missing ${id}.${extension}`);
      continue;
    }
    const bytes = readFileSync(path);
    const valid =
      extension === 'gif'
        ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!valid) {
      failures.push(`Invalid ${extension} signature: ${id}`);
    }
  }
}

function files(directory: string): string[] {
  if (!existsSync(resolve(root, directory))) {
    return [];
  }
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return files(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

// Track gameplay trees, including added/deleted files, rather than only the sources
// that happened to be cited when the manual was first written.
const sourcePaths = new Set([
  ...[
    'src/entities',
    'src/input',
    'src/physics',
    'src/constants',
    'src/asteroidTools',
    'src/core',
    'src/ui',
    'src/rendering',
    'src/network',
    'src/fx',
    'src/utils',
    'shared',
    'server/core',
    'server/communication',
    'server/ai',
    'server/services',
  ]
    .flatMap(files)
    .filter((path) => path.endsWith('.ts')),
  'wiki/index.html',
  'index.html',
  'index.css',
  'vite.config.ts',
  'middleware.ts',
  'package.json',
  'scripts/wiki-check.ts',
  'scripts/wiki-satellite-demo.ts',
  'shared-types.ts',
  'server/configuration.ts',
  'server.ts',
  ...articles.flatMap((article) => article.sources),
  ...Object.values(media).flatMap((item) => item.sources),
  ...files('src/wiki'),
  ...files('scripts').filter((path) => path.includes('/wiki-media')),
  ...files('public/wiki/media'),
]);
const hashes: Record<string, string> = {};
for (const path of [...sourcePaths].sort()) {
  if (existsSync(resolve(root, path))) {
    hashes[path] = `sha256:${createHash('sha256')
      .update(readFileSync(resolve(root, path)))
      .digest('hex')}`;
  }
}
if (process.argv.includes('--accept')) {
  const note = process.argv[process.argv.indexOf('--note') + 1];
  if (!process.argv.includes('--note') || !note || note.startsWith('--')) {
    failures.push('Acceptance requires --note with the completed source/media review summary');
  }
  if (failures.length === 0) {
    writeFileSync(baselinePath, `${JSON.stringify({ note, hashes }, null, 2)}\n`);
    process.stdout.write(
      `Wiki review recorded: ${articles.length} articles, ${Object.keys(media).length} demonstrations.\n`
    );
  }
} else if (!existsSync(baselinePath)) {
  failures.push(
    'Wiki has no accepted source review. Review articles and regenerate affected media, then run wiki:review with --note.'
  );
} else {
  const baseline: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (
    !baseline ||
    typeof baseline !== 'object' ||
    !('hashes' in baseline) ||
    !baseline.hashes ||
    typeof baseline.hashes !== 'object'
  ) {
    failures.push('Invalid wiki review baseline');
  } else {
    const previous = baseline.hashes;
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(hashes)])].filter(
      (path) => !(path in previous) || Reflect.get(previous, path) !== hashes[path]
    );
    if (changed.length) {
      failures.push(
        `Wiki review needed for ${changed.length} changed sources/assets:\n${changed.map((path) => `  ${relative(root, resolve(root, path))}`).join('\n')}\nReview rules and affected GIFs before accepting a new baseline. See docs/wiki-maintenance.md.`
      );
    }
  }
}
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Wiki coverage, links, media, and source review passed.\n');
}
