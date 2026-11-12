import { type ChildProcess, spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { BackupConfiguration } from './configuration';
import {
  type BackupReport,
  type BackupStage,
  type BackupWorkerMessage,
  readBackupWorkerMessage,
} from './protocol';

const RETRY_MS = 15 * 60 * 1000;
const JOB_DEADLINE_MS = 5 * 60 * 1000;

type BackupEvent =
  | { kind: 'backup_verified'; receipt: BackupReport }
  | { kind: 'backup_failed'; stage: BackupStage | 'worker' }
  | { kind: 'backup_deadline' | 'backup_shutdown' };

/** A separate process bounds native SQLite hangs and CPU/heap work outside the game thread. */
export function startBackupScheduler(options: {
  configuration: BackupConfiguration;
  worldPath: string;
  report: (event: BackupEvent) => void;
}): { close: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let completion = Promise.resolve();
  function schedule(delay: number): void {
    timer = setTimeout(run, delay);
    timer.unref();
  }
  function run(): void {
    if (stopped) {
      return;
    }
    const worker = spawn(
      process.execPath,
      [
        '--max-old-space-size=512',
        '--import',
        'tsx',
        fileURLToPath(new URL('../../scripts/world-backup.ts', import.meta.url)),
        'run',
        options.worldPath,
      ],
      {
        env: {
          ...process.env,
          GEOROIDS_BACKUP_ENABLED: '1',
          GEOROIDS_BACKUP_BUCKET: options.configuration.bucket,
          GEOROIDS_BACKUP_REGION: options.configuration.region,
          GEOROIDS_BACKUP_STAGING: options.configuration.stagingDirectory,
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }
    );
    child = worker;
    let failed = false;
    let result: BackupWorkerMessage | undefined;
    worker.on('message', (message: unknown) => {
      result = readBackupWorkerMessage(message);
    });
    const deadline = setTimeout(() => {
      failed = true;
      options.report({ kind: 'backup_deadline' });
      worker.kill('SIGKILL');
    }, JOB_DEADLINE_MS);
    deadline.unref();
    completion = new Promise<void>((resolve) => {
      worker.once('error', () => {
        failed = true;
      });
      worker.once('close', (code) => {
        clearTimeout(deadline);
        child = undefined;
        if (!stopped) {
          const verified = !failed && code === 0 && result?.kind === 'verified';
          options.report(
            verified && result?.kind === 'verified'
              ? { kind: 'backup_verified', receipt: result.receipt }
              : {
                  kind: 'backup_failed',
                  stage: result?.kind === 'failed' ? result.stage : 'worker',
                }
          );
          // Recheck existing deterministic UTC slots on retry and restart. Successful
          // runs sleep to the next UTC day, avoiding repeated full downloads.
          const now = Date.now();
          const nextDay = Math.floor(now / 86_400_000 + 1) * 86_400_000;
          const crossedDay =
            result?.kind === 'verified' &&
            result.receipt.day !== new Date(now).toISOString().slice(0, 10);
          schedule(verified ? (crossedDay ? 0 : nextDay - now) : RETRY_MS);
        }
        resolve();
      });
    });
  }
  schedule(0);
  return {
    async close() {
      stopped = true;
      clearTimeout(timer);
      if (child) {
        options.report({ kind: 'backup_shutdown' });
        child.kill('SIGKILL');
      }
      await completion;
    },
  };
}
