import { execFile } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listShipKits } from '../shared/shipKits';
import { media } from '../src/wiki/media';
import { readWikiArticles } from './wiki-content';
import { wikiSourceDigest } from './wiki-source-digest';

const execFileAsync = promisify(execFile);

export async function checkWiki({
  root,
  args,
}: {
  root: string;
  args: readonly string[];
}): Promise<{
  output: string;
  exitCode: 0 | 1;
}> {
  let output = '';
  const articles = readWikiArticles(root);
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
    if (!/^[a-z0-9-]+$/u.test(article.id)) {
      failures.push(`Invalid article ID: ${article.id}`);
    }
    if (!article.html.trim()) {
      failures.push(`Incomplete article: ${article.id}`);
    }
    for (const id of article.related) {
      if (!ids.has(id)) {
        failures.push(`${article.id}: broken related entry ${id}`);
      }
    }
    for (const id of article.media) {
      if (!Object.hasOwn(media, id)) {
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
          ? /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString())
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
    return readdirSync(resolve(root, directory), {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return files(path);
      }
      return entry.isFile() ? [path] : [];
    });
  }

  // Keep the wider inventory visible without requiring a gameplay review for
  // maintenance-only edits. Declared sources always override the advisory policy.
  const declaredSources = new Set([
    ...articles.flatMap((article) => article.sources),
    ...Object.values(media).flatMap((item) => item.sources),
  ]);
  const gameplayDirectories = [
    'src/audio',
    'src/entities',
    'src/input',
    'src/physics',
    'src/constants',
    'src/core',
    'src/runtime',
    'src/ui',
    'src/components/game',
    'src/components/wiki',
    'src/pages',
    'src/rendering',
    'src/network',
    'src/fx',
    'src/utils',
    'shared',
    'server/core',
    'server/communication',
    'server/ai',
    'server/services',
    'server/world',
  ];
  const reviewEntrypoints = new Set([
    'src/components/GameDocument.astro',
    'src/content.config.ts',
    'middleware.ts',
    'package.json',
    'scripts/wiki-check.ts',
    'scripts/client-build.ts',
    'scripts/client-release-sha.ts',
    'scripts/wiki-content.ts',
    'scripts/wiki-source-digest.ts',
    'scripts/wiki-satellite-demo.ts',
    'shared-types.ts',
    'server/configuration.ts',
    'server.ts',
  ]);
  function requiresReview(path: string): boolean {
    return (
      declaredSources.has(path) ||
      reviewEntrypoints.has(path) ||
      path.startsWith('src/wiki/') ||
      path.startsWith('scripts/wiki-media') ||
      ['public/wiki/media/', 'public/sounds/', 'public/music/'].some((directory) =>
        path.startsWith(directory)
      ) ||
      (/\.(ts|svelte|astro)$/u.test(path) &&
        gameplayDirectories.some((directory) => path.startsWith(`${directory}/`)))
    );
  }
  const sourcePaths = new Set([
    ...[...gameplayDirectories, 'src/diagnostics', 'src/release', 'src/components', 'src/styles']
      .flatMap(files)
      .filter((path) => /\.(ts|svelte|astro|css)$/u.test(path)),
    'index.css',
    'src/env.d.ts',
    'components.json',
    'config/quality/prettier.json',
    'config/app/astro.ts',
    'config/app/svelte.ts',
    'config/typescript/frontend.json',
    'config/typescript/tsconfig.json',
    'tsconfig.json',
    'tsconfig.frontend.json',
    ...reviewEntrypoints,
    ...declaredSources,
    ...files('src/wiki'),
    ...files('scripts').filter((path) => path.includes('/wiki-media')),
    ...files('public/wiki/media'),
    ...files('public/sounds'),
    ...files('public/music'),
  ]);
  const hashes: Record<string, string> = {};
  for (const path of [...sourcePaths].sort()) {
    if (existsSync(resolve(root, path))) {
      hashes[path] = wikiSourceDigest(path, readFileSync(resolve(root, path)));
    }
  }
  // Parse every selector before touching the accepted review. Old note/hash baselines
  // remain readable; acceptance always records an explicit, independently reviewable batch.
  const selected = new Set<string>();
  const topics = new Set<string>();
  const demonstrations = new Set<string>();
  const owners = new Map<string, string>();
  let accepting = false;
  let note = '';
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--accept') {
      if (accepting) {
        failures.push('Duplicate --accept');
      }
      accepting = true;
      continue;
    }
    const value = args[index + 1];
    if (
      !['--source', '--topic', '--media', '--owner', '--note'].includes(flag ?? '') ||
      !value ||
      value.startsWith('--') ||
      !value.trim()
    ) {
      failures.push(`Invalid Wiki review argument: ${flag}`);
      continue;
    }
    index++;
    if (flag === '--note') {
      if (note) {
        failures.push('Duplicate --note');
      }
      note = value.trim();
    } else if (flag === '--owner') {
      const parts = value.split('=');
      const [path, topic] = parts;
      if (parts.length !== 2 || !path || !topic || owners.has(path)) {
        failures.push(`Invalid or duplicate --owner: ${value}; use source/path=topic-id`);
      } else {
        owners.set(path, topic);
      }
    } else {
      const collection =
        flag === '--source' ? selected : flag === '--topic' ? topics : demonstrations;
      if (collection.has(value)) {
        failures.push(`Duplicate ${flag}: ${value}`);
      }
      collection.add(value);
    }
  }
  if (!accepting && args.length) {
    failures.push('Review selectors require --accept');
  }
  let baseline: Record<string, unknown> = {};
  let previous: Record<string, string> = {};
  try {
    const parsed: unknown = existsSync(baselinePath)
      ? JSON.parse(readFileSync(baselinePath, 'utf8'))
      : { hashes: {} };
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('hashes' in parsed) ||
      !parsed.hashes ||
      typeof parsed.hashes !== 'object' ||
      Array.isArray(parsed.hashes) ||
      Object.entries(parsed.hashes).some(
        ([path, hash]) => !path || typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(hash)
      )
    ) {
      failures.push('Invalid wiki review baseline');
    } else {
      baseline = Object.fromEntries(Object.entries(parsed));
      previous = Object.fromEntries(Object.entries(parsed.hashes));
      if ('reviews' in parsed && !Array.isArray(parsed.reviews)) {
        failures.push('Invalid wiki review batches');
      }
    }
  } catch {
    failures.push('Invalid wiki review baseline JSON');
  }
  const changedSources = [...new Set([...Object.keys(previous), ...Object.keys(hashes)])].filter(
    (path) => previous[path] !== hashes[path]
  );
  const changed = new Set(changedSources.filter(requiresReview));
  const advisory = changedSources.filter((path) => !requiresReview(path));
  const advisoryOutput = advisory.length
    ? `Advisory Wiki sources changed (${advisory.length}; no review note required):\n${advisory.map((path) => `  ${path}`).join('\n')}\n`
    : '';
  if (accepting) {
    if (!note || !selected.size || !topics.size) {
      failures.push(
        'Acceptance requires --note, repeated changed --source paths and affected --topic IDs'
      );
    }
    for (const topic of topics) {
      if (!ids.has(topic)) {
        failures.push(`Unknown topic: ${topic}`);
      }
    }
    for (const id of demonstrations) {
      if (!Object.hasOwn(media, id)) {
        failures.push(`Unknown media: ${id}`);
      }
    }
    for (const [path, topic] of owners) {
      if (!selected.has(path) || !ids.has(topic) || !topics.has(topic)) {
        failures.push(
          `Owner must name a selected source and selected real topic: ${path}=${topic}`
        );
      }
    }
    for (const path of selected) {
      if (!changed.has(path)) {
        failures.push(`Source is not changed: ${path}`);
      }
      const affectedMedia = Object.entries(media).filter(
        ([id, item]) =>
          item.sources.includes(path) ||
          ['gif', 'png'].some((extension) => path === `public/wiki/media/${id}.${extension}`)
      );
      const affectedTopics = articles.filter(
        (article) =>
          article.sources.includes(path) || affectedMedia.some(([id]) => article.media.includes(id))
      );
      if ((!affectedTopics.length || !(path in hashes)) && !owners.has(path)) {
        failures.push(`Unmapped or deleted source requires --owner ${path}=topic-id`);
      }
      for (const article of affectedTopics) {
        if (!topics.has(article.id)) {
          failures.push(`${path}: missing affected --topic ${article.id}`);
        }
      }
      for (const [id] of affectedMedia) {
        if (!demonstrations.has(id)) {
          failures.push(`${path}: missing affected --media ${id}`);
        }
      }
    }
    if (!failures.length) {
      const accepted = { ...previous };
      for (const path of selected) {
        const hash = hashes[path];
        if (hash !== undefined) {
          accepted[path] = hash;
        } else {
          delete accepted[path];
        }
      }
      const reviews = Array.isArray(baseline['reviews']) ? baseline['reviews'] : [];
      const updated = {
        ...baseline,
        hashes: accepted,
        reviews: [
          ...reviews,
          {
            note,
            sources: [...selected].sort(),
            topics: [...topics].sort(),
            media: [...demonstrations].sort(),
            owners: Object.fromEntries(owners),
          },
        ],
      };
      const formatting = execFileAsync(
        process.execPath,
        [
          resolve(root, 'node_modules/@biomejs/biome/bin/biome'),
          'format',
          `--config-path=${resolve(root, 'config/quality/biome.settings.jsonc')}`,
          '--vcs-enabled=false',
          '--stdin-file-path=docs/wiki-source-review.json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      const stdin = formatting.child.stdin;
      if (stdin === null) {
        await formatting;
        throw new Error('Biome formatter stdin is unavailable');
      }
      const [result, input] = await Promise.allSettled([
        formatting,
        pipeline(Readable.from([`${JSON.stringify(updated, null, 2)}\n`]), stdin),
      ]);
      // Report the formatter's diagnostics when it closes stdin early. A failed
      // input stream also rejects acceptance even if the process exits cleanly.
      if (result.status === 'rejected') {
        throw result.reason;
      }
      if (input.status === 'rejected') {
        throw input.reason;
      }
      const formatted = result.value.stdout;
      const temporary = `${baselinePath}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, formatted, { flag: 'wx' });
        renameSync(temporary, baselinePath);
      } finally {
        rmSync(temporary, { force: true });
      }
      const pending = [...changed].filter((path) => !selected.has(path));
      output = `Wiki review recorded for ${selected.size} sources; ${pending.length} pending sources.\n`;
    }
  } else if (!existsSync(baselinePath)) {
    failures.push(
      'Wiki has no accepted source review. Use explicit wiki:review source/topic selectors and --note.'
    );
  } else if (changed.size) {
    failures.push(
      `Wiki review needed for ${changed.size} changed sources/assets:\n${[...changed].map((path) => `  ${relative(root, resolve(root, path))}`).join('\n')}\nReview rules and affected GIFs before accepting selected sources. See docs/wiki-maintenance.md.`
    );
  }
  if (failures.length) {
    return { output: `${failures.join('\n')}\n${advisoryOutput}`, exitCode: 1 };
  }
  return {
    output: `${accepting ? output : 'Wiki coverage, links, media, and source review passed.\n'}${advisoryOutput}`,
    exitCode: 0,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkWiki({
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    args: process.argv.slice(2),
  });
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
  process.exitCode = result.exitCode;
}
