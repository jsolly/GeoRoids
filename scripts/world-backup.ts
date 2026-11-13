import { setPriority } from 'node:os';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { readBackupConfiguration } from '../server/backups/configuration';
import { BackupJobError } from '../server/backups/protocol';
import { runBackup } from '../server/backups/s3Backup';
import { inspectSnapshot } from '../server/backups/snapshot';

// Row validation errors can include private identities. This CLI deliberately
// prints only a fixed failure code and a nonzero status at its owning boundary.
try {
  const [mode, path] = process.argv.slice(2);
  if (!path || !isAbsolute(path)) {
    throw new Error('Absolute SQLite path required');
  }
  if (mode === 'inspect') {
    process.stdout.write(`${JSON.stringify(await inspectSnapshot(path))}\n`);
  } else if (mode === 'run') {
    const configuration = readBackupConfiguration();
    if (!configuration) {
      throw new Error('Backup is disabled');
    }
    process.umask(0o077);
    setPriority(19);
    const deadline = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 290_000);
    deadline.unref();
    try {
      const receipt = await runBackup({ configuration, worldPath: path });
      process.send?.({ kind: 'verified', receipt });
      process.stdout.write(`${JSON.stringify({ status: 'backup_verified', ...receipt })}\n`);
    } finally {
      clearTimeout(deadline);
    }
  } else {
    throw new Error('Usage: world-backup.ts inspect|run /absolute/world.sqlite');
  }
} catch (error) {
  const stage = error instanceof BackupJobError ? error.stage : 'staging';
  process.send?.({ kind: 'failed', stage });
  process.stderr.write(
    `${JSON.stringify({ level: 'error', event: 'world_backup_failed', stage })}\n`
  );
  process.exitCode = 1;
}

process.disconnect?.();
