import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const testSessionDirectory = process.env['GEOROIDS_TEST_SESSION_DIR'];

export default defineConfig({
  root: repositoryRoot,
  plugins: [svelte({ configFile: fileURLToPath(new URL('../app/svelte.ts', import.meta.url)) })],
  ...(testSessionDirectory ? { cacheDir: `${testSessionDirectory}/cache/vitest` } : {}),
  test: {
    root: repositoryRoot,
    ...(testSessionDirectory
      ? { fsModuleCachePath: `${testSessionDirectory}/cache/vitest-modules` }
      : {}),
    environment: 'jsdom',
    setupFiles: ['tests/viteSetup.ts'],
    globals: true,
    includeTaskLocation: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: configDefaults.include.map((pattern) => `tests/unit/${pattern}`),
          exclude: ['tests/unit/components/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          include: configDefaults.include.map((pattern) => `tests/unit/components/${pattern}`),
        },
        resolve: { conditions: ['browser'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: configDefaults.include.map((pattern) => `tests/integration/${pattern}`),
        },
      },
    ],
    exclude: configDefaults.exclude,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts', 'shared/**/*.ts', 'server/**/*.ts'],
      exclude: ['src/types/**', 'src/wiki/**'],
      reportsDirectory: 'coverage',
    },
    testTimeout: 120000, // watchdog for owned code-test I/O; scenario clocks advance explicitly
    hookTimeout: 30000,
    env: {
      VITEST: 'true',
      NODE_ENV: 'test',
    },
    // The documented single-worker policy applies to every code-test suite.
    pool: 'forks',
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    maxConcurrency: 1,
  },
  resolve: {
    extensions: ['.ts', '.js', '.svelte'],
    // DOM simulation does not turn Node transport dependencies into browser packages.
    // Only the Svelte component project needs client compilation conditions.
    conditions: ['node'],
  },
});
