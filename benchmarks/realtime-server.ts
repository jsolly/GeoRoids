import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServerInstance } from '../server/createServer';
import { flushServerLogs } from '../setup/serverLogger';
import { startFixtureControl } from './fixture-control';

const seed = Number(process.env['GEOROIDS_BENCHMARK_SEED'] ?? 42);
assert(Number.isSafeInteger(seed) && seed > 0, 'Benchmark seed must be a positive safe integer');
const server = createServerInstance({ seed });
await server.listening;
const session = process.env['GEOROIDS_BENCHMARK_SESSION'];
assert(session, 'Benchmark server requires an owned session');
let closeControl: () => Promise<void>;
try {
  closeControl = await startFixtureControl(server, join(session, 'fixture.sock'), seed);
} catch (error) {
  await server.close();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(closeControl),
      Promise.resolve().then(() => server.close()),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        process.stderr.write(`${String(result.reason)}\n`);
        process.exitCode = 1;
      }
    }
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
