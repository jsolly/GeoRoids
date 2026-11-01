import { createHash } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { clientViteConfig } from '../../scripts/client-build';

const vite = clientViteConfig();
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  site: 'https://www.georoids.com',
  output: 'static',
  cacheDir: './.performance/astro',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    assets: `_vercel/immutable/${createHash('sha256')
      .update(process.env['VERCEL_HASH_SALT'] ?? 'georoids-local')
      .digest('hex')
      .slice(0, 24)}`,
  },
  server: { host: '127.0.0.1', port: vite.server.port },
  integrations: [
    svelte({ configFile: fileURLToPath(new URL('./svelte.ts', import.meta.url)) }),
    {
      name: 'georoids-config-watch',
      hooks: {
        'astro:config:setup': ({ addWatchFile }) => {
          // Astro's explicit CLI selector is relative; native watcher events are absolute.
          addWatchFile(new URL('./astro.ts', import.meta.url));
        },
      },
    },
  ],
  vite: { ...vite, plugins: [...vite.plugins, tailwindcss()] },
});
