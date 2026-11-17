import process from 'node:process';
import { readBackupDestination } from '../server/backups/configuration';
import { downloadBackup } from '../server/backups/s3Backup';

try {
  const [key, expectedSha256, newDirectory] = process.argv.slice(2);
  if (!key || !expectedSha256 || !newDirectory) {
    throw new Error(
      'Usage: download-world-backup.ts daily|weekly/world-identity/YYYY-MM-DD.sqlite expected-sha256 /absolute/new-directory'
    );
  }
  if (!process.env['AWS_PROFILE']) {
    throw new Error('Local restore download requires the reviewed named AWS profile');
  }
  process.umask(0o077);
  const deadline = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 290000);
  deadline.unref();
  try {
    const receipt = await downloadBackup({
      destination: readBackupDestination(),
      key,
      expectedSha256,
      newDirectory,
    });
    process.stdout.write(
      `${JSON.stringify({ status: 'selected_backup_downloaded', ...receipt })}\n`
    );
  } finally {
    clearTimeout(deadline);
  }
} catch {
  process.stderr.write('{"level":"error","event":"selected_backup_download_failed"}\n');
  process.exitCode = 1;
}
