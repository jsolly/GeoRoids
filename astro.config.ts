import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { clientViteConfig } from './scripts/client-build';

const vite = clientViteConfig();
export default defineConfig({
  site: 'https://www.georoids.com',
  output: 'static',
  cacheDir: './.performance/astro',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  server: { host: '127.0.0.1', port: vite.server.port },
  integrations: [svelte()],
  vite: { ...vite, plugins: [...vite.plugins, tailwindcss()] },
});
