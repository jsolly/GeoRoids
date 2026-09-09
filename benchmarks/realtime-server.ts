import assert from 'node:assert/strict';
import { createServerInstance } from '../server/createServer';
import { flushServerLogs } from '../setup/serverLogger';

const seed = Number(process.env['GEOROIDS_BENCHMARK_SEED'] ?? 42);
assert(Number.isSafeInteger(seed) && seed > 0, 'Benchmark seed must be a positive safe integer');
const server = createServerInstance({ seed });
await server.listening;
let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await server.close();
    if (!(await flushServerLogs())) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
