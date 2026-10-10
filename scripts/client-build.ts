import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import type { Plugin } from 'vite';

const HAULER_TETHER_HEXES = ['#E8D5A3', '#FDE68A'] as const;
const GIT_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/iu;

/** Hosted platforms may set an empty SHA; `??` does not fall through that. */
function firstHostedCommitSha(): string | undefined {
  const candidates = [process.env['VERCEL_GIT_COMMIT_SHA'], process.env['RAILWAY_GIT_COMMIT_SHA']];
  for (const value of candidates) {
    if (typeof value === 'string' && GIT_COMMIT_SHA_PATTERN.test(value)) {
      return value;
    }
  }
  return undefined;
}

/** Attribute gameplay by source modules, independent of output filenames. */
function clientAssets(releaseSha: string): Plugin {
  return {
    name: 'client-assets',
    generateBundle(
      this: ThisParameterType<Exclude<Plugin['generateBundle'], undefined | { handler: unknown }>>,
      _options,
      bundle
    ) {
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
      const roots = chunks.filter((chunk) =>
        Object.keys(chunk.modules).some((id) => /\/src\/core\/main\.ts$/u.test(id))
      );
      // Astro also builds server-side page renderers. Only the client graph has this module.
      if (!roots.length) {
        return;
      }
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const reachable = new Set<string>();
      const visit = (name: string): void => {
        if (reachable.has(name)) {
          return;
        }
        const chunk = byName.get(name);
        if (!chunk) {
          throw new Error(`Missing attributed chunk: ${name}`);
        }
        reachable.add(name);
        for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
          if (byName.has(dependency)) {
            visit(dependency);
          }
        }
      };
      for (const root of roots) {
        visit(root.fileName);
      }
      for (const name of reachable) {
        if (
          Object.keys(byName.get(name)?.modules ?? {}).some((id) =>
            id.includes('/node_modules/echarts/')
          )
        ) {
          throw new Error('Gameplay must not load ECharts');
        }
      }
      const gameCode = [...reachable].map((name) => byName.get(name)?.code ?? '').join('\n');
      const missing = HAULER_TETHER_HEXES.filter((hex) => !gameCode.includes(hex));
      if (missing.length) {
        throw new Error(`Gameplay tether colors missing: ${missing.join(', ')}`);
      }
      const modules = Object.fromEntries(
        chunks.map((chunk) => [
          chunk.fileName,
          [...chunk.imports, ...chunk.dynamicImports].filter((name) => byName.has(name)),
        ])
      );
      this.emitFile({
        type: 'asset',
        fileName: 'client-assets.json',
        source: JSON.stringify({
          releaseSha,
          gameplay: [...reachable].sort(),
          modules,
        }),
      });
    },
  };
}

/** Generated documentation facts import gameplay rules at build time. Recreate
 * that module graph when their inputs change rather than reusing cached values. */
function refreshWikiFacts(): Plugin {
  return {
    name: 'refresh-wiki-facts',
    configureServer(server) {
      const refresh = (_event: string, file: string): void => {
        if (
          /\/(src|shared)\/.*\.(ts|json)$/u.test(file) ||
          /\/scripts\/wiki-[^/]+\.ts$/u.test(file)
        ) {
          // Let Astro rebuild its container, routes and content-module graph.
          // Restarting just Vite discards Astro's outer HTTP middleware.
          server.watcher.emit('change', resolve(server.config.root, 'astro.config.ts'));
        }
      };
      server.watcher.on('all', refresh);
      server.httpServer?.once('close', () => server.watcher.off('all', refresh));
    },
  };
}

/** Publish the same full identity embedded in the built client. */
function publishClientRelease(releaseSha: string): Plugin {
  const source = JSON.stringify({ releaseSha });
  return {
    name: 'client-release-manifest',
    generateBundle(
      this: ThisParameterType<Exclude<Plugin['generateBundle'], undefined | { handler: unknown }>>
    ) {
      this.emitFile({ type: 'asset', fileName: 'release.json', source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url ?? '/', 'http://vite.local').pathname !== '/release.json') {
          next();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(request.method === 'HEAD' ? '' : source);
      });
    },
  };
}

export function clientViteConfig() {
  const define: Record<string, string> = {};
  const testVitePort = Number(process.env['GEOROIDS_TEST_VITE_PORT'] ?? 5173);
  const testServerPort = process.env['GEOROIDS_TEST_SERVER_PORT'] ?? '3001';

  // Inject build time
  define['import.meta.env.VITE_BUILD_TIME'] = JSON.stringify(new Date().toISOString());

  // Hosted builds may omit .git; release polling still needs the deployed identity.
  const commitHash =
    firstHostedCommitSha() ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  if (!GIT_COMMIT_SHA_PATTERN.test(commitHash)) {
    throw new Error('Cannot build client without a valid Git commit SHA');
  }
  define['import.meta.env.VITE_COMMIT_HASH'] = JSON.stringify(commitHash.slice(0, 7));
  define['import.meta.env.VITE_COMMIT_SHA'] = JSON.stringify(commitHash.toLowerCase());

  // VITE_WEBSOCKET_URL comes from .env.local (dev) or Vercel env (production).
  // Do not define it here — vite `define` overrides env and breaks production builds.

  return {
    ...(process.env['GEOROIDS_TEST_SESSION_DIR']
      ? { cacheDir: `${process.env['GEOROIDS_TEST_SESSION_DIR']}/cache/vite` }
      : {}),
    envPrefix: ['PUBLIC_', 'VITE_WEBSOCKET_URL'],
    plugins: [
      refreshWikiFacts(),
      publishClientRelease(commitHash.toLowerCase()),
      clientAssets(commitHash.toLowerCase()),
    ],
    preview: { strictPort: true },
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
}
