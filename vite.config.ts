import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

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
    resolve: {
      extensions: ['.ts'],
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
