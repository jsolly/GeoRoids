import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { readWikiArticles } from './wiki-content';

/** Keep Markdown/YAML parsers and game reference imports out of the wiki browser bundle. */
export function wikiContentPlugin(): Plugin {
  const publicId = 'virtual:wiki-content';
  const resolvedId = `\0${publicId}`;
  let root = process.cwd();
  return {
    name: 'wiki-content',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      return id === publicId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) {
        return undefined;
      }
      const articles = readWikiArticles(root);
      return `export const articles = ${JSON.stringify(articles)};`;
    },
    configureServer(server) {
      server.watcher.add(resolve(root, 'content/wiki'));
      server.watcher.on('all', (_event, path) => {
        if (!path.startsWith(`${resolve(root, 'content/wiki')}/`)) {
          return;
        }
        const module = server.moduleGraph.getModuleById(resolvedId);
        if (module) {
          server.moduleGraph.invalidateModule(module);
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}
