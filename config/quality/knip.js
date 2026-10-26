const config = {
  $schema: '../../node_modules/knip/schema.json',
  // These files are invoked by Railway/Vite/Vitest or discovered dynamically by
  // the shell runners, so package.json alone cannot describe every entrypoint.
  entry: [
    'server.ts',
    'server/world/worldStoreWorker.ts',
    'server/debugReports/worker.ts',
    '.railway/**/*.ts',
    'scripts/**/*.ts',
    // A shell runner launches this listener through dev-server-contract.sh, which
    // Knip cannot follow from the spawning test. It exports nothing, so entry
    // placement forfeits no unused-export coverage.
    'scripts/contract-listener.mjs',
    'src/pages/**/*.astro',
    'benchmarks/client.html',
    'benchmarks/protocol-experiment.ts',
    'benchmarks/realtime-server.ts',
    'benchmarks/sample.ts',
    'benchmarks/realtime-client.ts',
    'benchmarks/load.ts',
    'tests/**/*.test.ts',
  ],
  project: [
    'benchmarks/**/*.ts',
    'src/**/*.{ts,tsx,svelte,astro,css}',
    'server/**/*.ts',
    'shared/**/*.ts',
    'shared-types.ts',
    'setup/**/*.ts',
    '.railway/**/*.ts',
    'scripts/**/*.{ts,mjs}',
    'tests/**/*.ts',
    'config/app/**/*.ts',
    'config/testing/**/*.ts',
  ],
  // These dependencies are executed by shell scripts, CI, or deployment
  // tooling; Knip cannot infer those non-TypeScript consumers.
  // afconvert is the macOS system encoder used by sounds:generate.
  ignoreBinaries: ['uvx', 'afconvert'],
  ignoreDependencies: ['concurrently', 'markdownlint-cli2', 'jsonc-parser', 'shadcn-svelte'],
  astro: { config: ['config/app/astro.ts'] },
  svelte: { entry: ['config/app/svelte.js', 'vite.config.{js,mjs,ts,cjs,mts,cts}'] },
  vitest: { config: ['config/testing/vitest.ts', 'config/testing/tooling.ts'] },
  biome: { config: ['config/quality/biome.settings.jsonc'] },
  prettier: { config: ['config/quality/prettier.json'] },
};

export default config;
