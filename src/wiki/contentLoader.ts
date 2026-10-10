import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Loader } from 'astro/loaders';
import { readWikiArticles } from '../../scripts/wiki-content';

const REFERENCE_TREE_PATTERN = /^(src|shared)\//u;
const REFERENCE_EXTENSION_PATTERN = /\.(ts|json)$/u;
const COMPILER_PATTERN = /^scripts\/wiki-[^/]+\.ts$/u;

/** One validated compiler serves Astro, Pages CMS checks and reference generation. */
export function wikiContentLoader(): Loader {
  return {
    name: 'georoids-validated-wiki',
    load({ store, config, generateDigest, watcher, logger }) {
      const root = fileURLToPath(config.root);
      const refresh = () => {
        // Compile the whole collection first. An invalid editor save must not
        // partially replace valid entries, and deleted articles must disappear.
        const articles = readWikiArticles(root);
        store.clear();
        for (const article of articles) {
          store.set({
            id: article.id,
            data: { ...article },
            digest: generateDigest({ ...article }),
          });
        }
      };
      refresh();
      if (watcher) {
        watcher.add([
          resolve(root, 'content/wiki'),
          resolve(root, 'src'),
          resolve(root, 'shared'),
          resolve(root, 'scripts'),
        ]);
        watcher.on('all', (_event, path) => {
          const source = relative(root, path).replaceAll('\\', '/');
          if (wikiLoaderInput(source)) {
            try {
              refresh();
            } catch (error) {
              logger.error(
                `Wiki content refresh failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        });
      }
      return Promise.resolve();
    },
  };
}

/** Editorial changes and generated facts share the same development invalidation. */
function wikiLoaderInput(path: string): boolean {
  return (
    path.startsWith('content/wiki/') ||
    (REFERENCE_TREE_PATTERN.test(path) && REFERENCE_EXTENSION_PATTERN.test(path)) ||
    COMPILER_PATTERN.test(path)
  );
}
