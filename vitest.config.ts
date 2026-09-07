import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/viteSetup.ts'],
    globals: true,
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
