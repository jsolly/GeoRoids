import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const testSessionDirectory = process.env['GEOROIDS_TEST_SESSION_DIR'];

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  ...(testSessionDirectory ? { cacheDir: `${testSessionDirectory}/cache/tooling-vitest` } : {}),
  test: {
    ...(testSessionDirectory
      ? { fsModuleCachePath: `${testSessionDirectory}/cache/tooling-vitest-modules` }
      : {}),
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    sequence: { concurrent: false },
    maxConcurrency: 1,
    testTimeout: 120000,
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: 'runner',
          include: [
            'scripts/code-integration-runner.test.mjs',
            'scripts/benchmark-runner.test.mjs',
            'scripts/benchmark-build-receipt.test.mjs',
            'scripts/test-ports.test.mjs',
            'scripts/validation-admission.test.mjs',
            'scripts/check-built-client.test.mjs',
            'scripts/check-unused-typescript.test.mjs',
            'scripts/check-unused-class-members.test.mjs',
            'scripts/typescript-toolchain.test.mjs',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'actions',
          include: [
            'scripts/ci-contract.test.mjs',
            'scripts/gate-contract.test.mjs',
            'scripts/review-receipt-contract.test.mjs',
            'scripts/preview-comment.test.mjs',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'smoke',
          include: [
            'scripts/server-release-inputs.test.mjs',
            'scripts/production-smoke-scenario.test.mjs',
          ],
        },
      },
      { extends: true, test: { name: 'dev-server', include: ['scripts/dev-server.test.mjs'] } },
      { extends: true, test: { name: 'lint-policy', include: ['scripts/lint-policy.test.mjs'] } },
    ],
  },
});
