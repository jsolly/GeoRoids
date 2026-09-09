import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/viteSetup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts', 'shared/**/*.ts', 'server/**/*.ts'],
      exclude: ['src/types/**', 'src/wiki/**'],
      reportsDirectory: 'coverage',
    },
    testTimeout: 120000, // browser E2E scenarios (respawn cycles can exceed 60s under load)
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
