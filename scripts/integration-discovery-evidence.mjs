import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { version, viteVersion } from 'vitest/node';
import { authorizeDiscoveryEvidence, writeJson } from './integration-shards.mjs';

function captureAndRetentionFailure(capture, retention) {
  return new AggregateError(
    [capture, retention],
    'Discovery cache evidence capture and retention failed',
    { cause: capture }
  );
}

export default function discoveryEvidence() {
  const attached = new WeakSet();
  return {
    name: 'georoids-discovery-evidence',
    configureVitest({ vitest }) {
      if (attached.has(vitest)) {
        return;
      }
      const issued = authorizeDiscoveryEvidence(false);
      if (version !== '5.0.1') {
        throw new Error('Discovery evidence requires reviewed Vitest 5.0.1');
      }
      attached.add(vitest);
      const clock = () => ({ wallMs: Date.now(), monotonicMs: performance.now() });
      const costPath = join(issued.directory, 'native-cache-collection.json');
      const cost = issued.nativeCompileCacheTreatment
        ? {
            version: 1,
            runId: issued.runId,
            nonce: issued.nativeCompileCacheNonce,
            treatment: issued.nativeCompileCacheTreatment,
            sourceFingerprint: issued.sourceFingerprint.sha256,
            node: process.version,
            vitest: version,
            vite: viteVersion,
            complete: false,
            evidenceErrors: [],
            files: [],
            registeredAt: clock(),
            semantics:
              'collection snapshot only; zero execution duration is unavailable test execution; close snapshot is not global close completion',
          }
        : null;
      if (cost) {
        writeJson(costPath, cost);
      }
      vitest.onClose(() => {
        if (cost) {
          cost.snapshotStartedAt = clock();
        }
        try {
          const modules = vitest.state.getTestModules();
          const files = modules.map((module) => ({
            file: module.moduleId,
            errors: [module, ...module.children.allSuites()].flatMap((suite) => suite.errors()),
          }));
          if (cost) {
            cost.files = modules.map((module) => ({
              file: module.moduleId,
              diagnostic: Object.fromEntries(
                [
                  'environmentSetupDuration',
                  'prepareDuration',
                  'setupDuration',
                  'collectDuration',
                  'duration',
                ].map((key) => [key, module.diagnostic()[key]])
              ),
            }));
            cost.snapshotFinishedBeforeWrite = clock();
          }
          writeJson(join(issued.directory, 'collection.json'), {
            runId: issued.runId,
            files,
            unhandledErrors: vitest.state.getUnhandledErrors(),
            node: process.version,
            vitest: version,
            vite: viteVersion,
            architecture: process.arch,
            platform: process.platform,
            completedAt: Date.now(),
            registrationEnvironment: Object.fromEntries(
              [
                'NODE_ENV',
                'VITEST',
                'SERVER_LOG_LEVEL',
                'GEOROIDS_TEST_SERVER_PORT',
                'GEOROIDS_TEST_VITE_PORT',
                'GEOROIDS_SHARD_MANIFEST',
              ].map((key) => [key, process.env[key] ?? null])
            ),
          });
          if (cost) {
            cost.complete = true;
            writeJson(costPath, cost);
          }
        } catch (error) {
          if (!cost) {
            throw error;
          }
          cost.complete = false;
          cost.evidenceErrors.push({ name: error.name, message: error.message });
          process.exitCode = 1;
          try {
            writeJson(costPath, cost);
          } catch (retentionError) {
            throw captureAndRetentionFailure(error, retentionError);
          }
          throw error;
        }
      });
    },
  };
}
