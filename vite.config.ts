import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { wikiContentPlugin } from './scripts/wiki-vite';

const HAULER_TETHER_HEXES = ['#E8D5A3', '#FDE68A'] as const;

/** Fail the client build if Rolldown drops or cross-chunk-aliases the cream/tip hexes. */
function requireHaulerTetherHexes(): Plugin {
  return {
    name: 'require-hauler-tether-hexes',
    generateBundle(_options, bundle) {
      const gameChunks = Object.values(bundle).filter(
        (item) => item.type === 'chunk' && item.fileName.startsWith('assets/game-')
      );
      if (gameChunks.length === 0) {
        throw new Error('require-hauler-tether-hexes: no assets/game-*.js chunk emitted');
      }
      for (const chunk of gameChunks) {
        if (chunk.type !== 'chunk') {
          continue;
        }
        const missing = HAULER_TETHER_HEXES.filter((hex) => !chunk.code.includes(hex));
        if (missing.length > 0) {
          throw new Error(
            `Hauler cream/tip hexes missing from ${chunk.fileName}: ${missing.join(', ')}`
          );
        }
      }
    },
  };
}

/** Match the production wiki rewrite in development and build previews. */
function wikiEntry(request: IncomingMessage, _response: ServerResponse, next: () => void): void {
  const url = new URL(request.url ?? '/', 'http://vite.local');
  if (url.pathname === '/wiki' || url.pathname === '/wiki/') {
    request.url = `/wiki/index.html${url.search}`;
  }
  next();
}

export default defineConfig(() => {
  const define: Record<string, string> = {};
  const testVitePort = Number(process.env['GEOROIDS_TEST_VITE_PORT'] ?? 5173);
  const testServerPort = process.env['GEOROIDS_TEST_SERVER_PORT'] ?? '3001';

  // Inject build time
  define['import.meta.env.VITE_BUILD_TIME'] = JSON.stringify(new Date().toISOString());

  // Hosted builds may omit .git; release polling still needs the deployed identity.
  const commitHash =
    process.env['VERCEL_GIT_COMMIT_SHA'] ??
    process.env['RAILWAY_GIT_COMMIT_SHA'] ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  if (!/^[a-f0-9]{40}$/i.test(commitHash)) {
    throw new Error('Cannot build client without a valid Git commit SHA');
  }
  define['import.meta.env.VITE_COMMIT_HASH'] = JSON.stringify(commitHash.slice(0, 7));

  // VITE_WEBSOCKET_URL comes from .env.local (dev) or Vercel env (production).
  // Do not define it here — vite `define` overrides env and breaks production builds.

  return {
    plugins: [
      wikiContentPlugin(),
      requireHaulerTetherHexes(),
      {
        name: 'wiki-entry',
        configureServer(server) {
          server.middlewares.use(wikiEntry);
        },
        configurePreviewServer(server) {
          server.middlewares.use(wikiEntry);
        },
      },
    ],
    resolve: {
      extensions: ['.ts'],
    },
    build: {
      rolldownOptions: {
        input: { game: 'index.html', wiki: 'wiki/index.html' },
      },
    },
    server: {
      port: testVitePort,
      strictPort: true, // Fail if port is not available
      proxy: {
        '/ws': {
          target: `ws://localhost:${testServerPort}`,
          ws: true,
          changeOrigin: true,
          secure: false,
        },
        '/logs': {
          target: `ws://localhost:${testServerPort}`,
          ws: true,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    define,
  };
});
