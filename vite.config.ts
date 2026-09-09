import { execSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig } from 'vite';

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

  // Get the current git commit hash
  let commitHash = 'unknown';
  try {
    commitHash = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    console.warn('Could not get git commit hash:', error);
  }
  define['import.meta.env.VITE_COMMIT_HASH'] = JSON.stringify(commitHash);

  // VITE_WEBSOCKET_URL comes from .env.local (dev) or Vercel env (production).
  // Do not define it here — vite `define` overrides env and breaks production builds.

  return {
    plugins: [
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
      target: 'esnext',
      modulePreload: false,
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
