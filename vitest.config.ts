import process from 'node:process';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  ...(process.env['GEOROIDS_TEST_SESSION_DIR']
    ? { cacheDir: `${process.env['GEOROIDS_TEST_SESSION_DIR']}/cache/vitest` }
    : {}),
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/viteSetup.ts'],
    globals: true,
    includeTaskLocation: true,
    // Vitest does not read .gitignore; keep default discovery out of nested
    // Claude desktop worktrees (other branches' test files).
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts', 'shared/**/*.ts', 'server/**/*.ts'],
      exclude: ['src/types/**', 'src/wiki/**'],
      reportsDirectory: 'coverage',
    },
    testTimeout: 120000, // watchdog for owned code-test I/O; scenario clocks advance explicitly
    hookTimeout: 30000, // 30 seconds for hooks
    env: {
      VITEST: 'true',
      NODE_ENV: 'test',
    },
    // Keep one isolated worker so integration tests cannot burst WebSocket
    // connections while still resetting module state between files.
    pool: 'forks',
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    maxConcurrency: 1,
    // Preserve the pre-v5 mock lifecycle until individual tests opt into
    // clearing mocks explicitly.
    clearMocks: false,
  },
  resolve: {
    extensions: ['.ts'],
  },
});
