import { createServerInstance } from './server/createServer';
import { SERVER_RELEASE_ID } from './server/release';
import { flushServerLogs, logger } from './setup/serverLogger';
import { boundedDiagnosticError } from './shared/stateDiagnostics';

const server = createServerInstance();
let shuttingDown = false;
let requestedExitCode = 0;

async function shutdown(exitCode: number): Promise<void> {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await server.close();
    logger.info('Server closed');
  } catch (error) {
    requestedExitCode = 1;
    logger.error('Failed to shut down server', error);
  }
  if (!(await flushServerLogs())) {
    requestedExitCode = 1;
  }
  process.exit(requestedExitCode);
}

process.once('uncaughtException', (value) => {
  logger.error('STATE', 'uncaught_exception', {
    releaseId: SERVER_RELEASE_ID,
    observedAt: Date.now(),
    error: boundedDiagnosticError(value, 'Unknown uncaught exception'),
  });
  void shutdown(1);
});

process.once('unhandledRejection', (value) => {
  logger.error('STATE', 'unhandled_rejection', {
    releaseId: SERVER_RELEASE_ID,
    observedAt: Date.now(),
    error: boundedDiagnosticError(value, 'Unhandled non-Error rejection'),
  });
  void shutdown(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info(`Received ${signal}, shutting down`);
    void shutdown(0);
  });
}
void server.listening
  .then((port) => {
    logger.info('STATE', 'server_started', {
      releaseId: SERVER_RELEASE_ID,
      observedAt: Date.now(),
      port,
    });
  })
  .catch((error) => {
    logger.error('Failed to start server listener', error);
    void shutdown(1);
  });
