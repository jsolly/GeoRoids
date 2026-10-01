import { defineConfig, mergeConfig } from 'vitest/config';
import discoveryEvidence from './scripts/integration-discovery-evidence.mjs';
import browserConfig from './vitest.browser.config';

export default mergeConfig(
  browserConfig,
  defineConfig({
    plugins: [discoveryEvidence()],
    test: {
      setupFiles: ['./scripts/integration-discovery-probe.mjs'],
    },
  })
);
