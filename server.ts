import { realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import process from 'node:process';
import { readServerConfiguration } from './server/configuration';
import { createServerInstance } from './server/createServer';
import { SERVER_RELEASE_ID } from './server/release';
import { flushServerLogs, logger } from './setup/serverLogger';
import { boundedDiagnosticError } from './shared/stateDiagnostics';

const configuration = readServerConfiguration();
const localWorld = configuration.nodeEnv === 'development' || configuration.nodeEnv === 'test';
const worldPath =
  process.env['GEOROIDS_WORLD_PATH'] ?? (localWorld ? '.data/world.sqlite' : undefined);
if (!worldPath) {
  throw new Error('GEOROIDS_WORLD_PATH must point to the mounted persistent world volume');
}
if (!localWorld) {
  const mountPath = process.env['RAILWAY_VOLUME_MOUNT_PATH'];
  if (
    !mountPath ||
    !isAbsolute(worldPath) ||
    realpathSync(dirname(worldPath)) !== realpathSync(mountPath)
  ) {
    throw new Error('Production world database must be directly inside RAILWAY_VOLUME_MOUNT_PATH');
  }
}
const server = createServerInstance({ ...configuration, worldPath });
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
