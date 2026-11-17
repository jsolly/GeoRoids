import process from 'node:process';

// Load the server only after selecting private, quiet local rehearsal logging.
process.env['NODE_ENV'] = 'test';
process.env['SERVER_LOG_LEVEL'] = 'error';
try {
  if (process.env['RAILWAY_ENVIRONMENT_ID'] !== undefined) {
    throw new Error('This rehearsal command is local only');
  }
  const [artifact, expectedSha256, scratchDirectory] = process.argv.slice(2);
  if (!artifact || !expectedSha256 || !scratchDirectory) {
    throw new Error(
      'Usage: rehearse-world-restore.ts /absolute/artifact.sqlite expected-sha256 /absolute/new-scratch-directory'
    );
  }
  const deadline = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 60_000);
  deadline.unref();
  try {
    const { rehearseRestore } = await import('../server/backups/rehearsal');
    const result = await rehearseRestore({ artifact, expectedSha256, scratchDirectory });
    process.stdout.write(`${JSON.stringify({ status: 'local_restore_rehearsed', ...result })}\n`);
  } finally {
    clearTimeout(deadline);
  }
} catch {
  process.stderr.write('{"level":"error","event":"local_restore_rehearsal_failed"}\n');
  process.exitCode = 1;
}
