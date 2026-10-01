import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, getCompileCacheDir } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { __INTERNAL } from 'vitest/runtime';
import { authorizeDiscoveryEvidence, writeJson } from './integration-shards.mjs';

const issued = authorizeDiscoveryEvidence(true);
const version = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('vitest/package.json'), 'utf8')
).version;
// Vitest 5.0.1 exposes this internal accessor at runtime, but omits its types.
// Discovery fails rather than guessing an environment after an incompatible upgrade.
if (version !== '5.0.1' || typeof __INTERNAL?.getWorkerState !== 'function') {
  throw new Error('Discovery environment probe requires the reviewed Vitest 5.0.1 runtime');
}
const state = __INTERNAL.getWorkerState();
if (typeof state?.filepath !== 'string' || typeof state.environment?.name !== 'string') {
  throw new Error('Discovery worker environment shape differs from the reviewed runtime');
}
const file = realpathSync(state.filepath);
const digest = createHash('sha256').update(file).digest('hex');
const output = join(issued.directory, 'environments', `${digest}.json`);
if (existsSync(output)) {
  throw new Error('Discovery repeated a resolved environment record');
}
writeJson(output, {
  runId: issued.runId,
  file,
  environment: state.environment.name,
  workerPid: process.pid,
  node: process.version,
  vitest: version,
  observedAt: Date.now(),
  ...(issued.nativeCompileCacheTreatment
    ? {
        workerTimeOrigin: performance.timeOrigin,
        architecture: process.arch,
        platform: process.platform,
        vite: JSON.parse(
          readFileSync(createRequire(import.meta.url).resolve('vite/package.json'), 'utf8')
        ).version,
        sourceFingerprint: issued.sourceFingerprint.sha256,
        observedClock: { wallMs: Date.now(), monotonicMs: performance.now() },
        nativeCompileCache: {
          treatment: issued.nativeCompileCacheTreatment,
          nonce: issued.nativeCompileCacheNonce,
          directory: getCompileCacheDir() ?? null,
          controls: Object.fromEntries(
            [
              'NODE_COMPILE_CACHE',
              'NODE_DISABLE_COMPILE_CACHE',
              'NODE_COMPILE_CACHE_PORTABLE',
              'NODE_COMPILE_CACHE_READONLY',
              'NODE_COMPILE_CACHE_READ_ONLY',
            ].map((key) => [key, process.env[key] ?? null])
          ),
        },
      }
    : {}),
});
