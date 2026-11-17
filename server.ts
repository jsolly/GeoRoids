import { realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readBackupConfiguration } from './server/backups/configuration';
import { startBackupScheduler } from './server/backups/scheduler';
import { readServerConfiguration } from './server/configuration';
import { createServerInstance } from './server/createServer';
import { SERVER_RELEASE_ID } from './server/release';
import { includesUnreleasedWriter } from './server/world/worldPersistence';
import { flushServerLogs, logger } from './setup/serverLogger';
import { boundedDiagnosticError } from './shared/stateDiagnostics';

const configuration = readServerConfiguration();
const backupConfiguration = readBackupConfiguration();
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
const server = createServerInstance({
  port: configuration.port,
  nodeEnv: configuration.nodeEnv,
  localPlayground: configuration.localPlayground,
  worldPath,
  ...(configuration.previewClient
    ? { serveClientFrom: fileURLToPath(new URL('./dist/', import.meta.url)) }
    : {}),
});
const backups = backupConfiguration
  ? startBackupScheduler({
      configuration: backupConfiguration,
      worldPath,
      report: (event) => {
        if (event.kind === 'backup_failed' || event.kind === 'backup_deadline') {
          logger.error('STATE', event.kind, { operation: 'world_backup', ...event });
        } else {
          logger.info('STATE', event.kind, { operation: 'world_backup', ...event });
        }
      },
    })
  : undefined;
let shuttingDown = false;
let requestedExitCode = 0;

async function shutdown(exitCode: number): Promise<void> {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  let writerUnreleased = false;
  try {
    await backups?.close();
    await server.close();
    logger.info('Server closed');
  } catch (error) {
    requestedExitCode = 1;
    writerUnreleased = includesUnreleasedWriter(error);
    logger.error('Failed to shut down server', error);
  }
  if (!(await flushServerLogs())) {
    requestedExitCode = 1;
  }
  if (writerUnreleased) {
    // process.exit joins worker threads, and a writer stuck in a native SQLite
    // call would hold it until the platform's SIGKILL. The logs are flushed
    // and the reason recorded, so end the process without waiting for it.
    process.kill(process.pid, 'SIGKILL');
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
