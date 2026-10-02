import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';

export type BenchmarkCompressionMode =
  | 'none'
  | 'deflate-level1-no-context'
  | 'deflate-level1-no-context-8k';

export function isBenchmarkCompressionMode(value: unknown): value is BenchmarkCompressionMode {
  return (
    value === 'none' ||
    value === 'deflate-level1-no-context' ||
    value === 'deflate-level1-no-context-8k'
  );
}

/** A transport experiment, never a production environment switch. */
export function readBenchmarkCompression(value: string | undefined): {
  mode: BenchmarkCompressionMode;
  perMessageDeflate: false | WebSocket.PerMessageDeflateOptions;
} {
  const mode = value ?? 'none';
  assert(
    isBenchmarkCompressionMode(mode),
    'GEOROIDS_BENCHMARK_COMPRESSION must be none, deflate-level1-no-context or deflate-level1-no-context-8k'
  );
  return {
    mode,
    perMessageDeflate:
      mode === 'none'
        ? false
        : {
            zlibDeflateOptions: { level: 1, memLevel: 5 },
            serverMaxWindowBits: 15,
            clientMaxWindowBits: 15,
            serverNoContextTakeover: true,
            clientNoContextTakeover: true,
            concurrencyLimit: 4,
            // ws honors this threshold only without context takeover. Avoid
            // spending server deflate work on ordinary small control/events.
            threshold: mode === 'deflate-level1-no-context-8k' ? 8192 : 1024,
          },
  };
}
