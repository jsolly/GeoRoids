import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createServerInstance } from '../server/createServer';

const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();
let server: ReturnType<typeof createServerInstance> | undefined;
let closing = false;

function send(message: object) {
  return new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('Transport parent IPC is unavailable'));
      return;
    }
    process.send(message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}

async function shutdown(failure?: unknown) {
  if (closing) {
    if (failure !== undefined) {
      process.exitCode = 1;
    }
    return;
  }
  closing = true;
  // The parent also bounds shutdown and awaits forced termination if this expires.
  const timeout = setTimeout(() => process.exit(1), 4_000).unref();
  try {
    await server?.close();
    if (failure !== undefined) {
      throw failure;
    }
    eventLoopDelay.disable();
    const eventLoopDelayMs = {
      meanMs: eventLoopDelay.mean / 1_000_000,
      p99Ms: eventLoopDelay.percentile(99) / 1_000_000,
      maxMs: eventLoopDelay.max / 1_000_000,
    };
    assert(
      Object.values(eventLoopDelayMs).every((value) => Number.isFinite(value) && value >= 0),
      'Server event-loop measurements are unavailable'
    );
    await send({ type: 'closed', eventLoopDelayMs });
  } catch (error) {
    process.exitCode = 1;
    try {
      await send({
        type: 'fatal',
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // A lost parent cannot receive the failure; the process still exits unsuccessfully.
      process.exitCode = 1;
    }
  } finally {
    if (process.exitCode !== 1) {
      clearTimeout(timeout);
    }
    eventLoopDelay.disable();
    if (process.connected) {
      process.disconnect();
    }
  }
}

process.on('message', (message: unknown) => {
  const valid =
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'shutdown';
  void shutdown(valid ? undefined : new Error('Invalid transport shutdown message'));
});
process.once('disconnect', () => {
  if (!closing) {
    void shutdown(new Error('Transport parent disconnected'));
  }
});
process.once('SIGTERM', () => {
  void shutdown(new Error('Transport child received SIGTERM'));
});
process.once('SIGINT', () => {
  void shutdown(new Error('Transport child received SIGINT'));
});
process.once('uncaughtException', (error) => {
  void shutdown(error);
});
process.once('unhandledRejection', (error: unknown) => {
  void shutdown(error);
});

try {
  server = createServerInstance({ port: 0, nodeEnv: 'test', requireEnhancedClient: true });
  void server.listening.then((port) => send({ type: 'ready', port })).catch(shutdown);
} catch (error) {
  void shutdown(error);
}
