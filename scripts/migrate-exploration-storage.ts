import { closeSync, openSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  assertExplorationDatabaseIntegrity,
  explorationStorageFingerprint,
  inspectExplorationStorage,
  transitionExplorationStorage,
} from '../server/world/explorationSchema';

const [mode, path, expectedFingerprint, backupPath] = process.argv.slice(2);
if (
  !path ||
  !isAbsolute(path) ||
  !['inspect', 'dry-run', 'prepare', 'activate', 'rollback'].includes(mode ?? '')
) {
  throw new Error(
    'Usage: tsx scripts/migrate-exploration-storage.ts inspect|dry-run|prepare|activate|rollback /absolute/world.sqlite [expected-sha256] [/absolute/new-backup.sqlite]'
  );
}
if (!statSync(path).isFile()) {
  throw new Error('Migration requires an existing database file');
}
const readOnly = mode === 'inspect' || mode === 'dry-run';
const db = new DatabaseSync(path, { readOnly });
try {
  // The read transaction makes both the fingerprint and validation one snapshot.
  db.exec('BEGIN');
  assertExplorationDatabaseIntegrity(db);
  const before = inspectExplorationStorage(db);
  const fingerprint = explorationStorageFingerprint(db);
  db.exec('COMMIT');
  if (mode === 'prepare' || mode === 'activate' || mode === 'rollback') {
    if (
      expectedFingerprint !== fingerprint ||
      !backupPath ||
      !isAbsolute(backupPath) ||
      backupPath === path
    ) {
      throw new Error(
        'A transition requires the current inspection SHA256 and a new absolute backup path'
      );
    }
    // Reserve a private new file first. SQLite alone also accepts existing
    // empty files, which must never be mistaken for permission to overwrite.
    closeSync(openSync(backupPath, 'wx', 0o600));
    // Online backup includes committed WAL and retains implicit row identities.
    await backup(db, backupPath);
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assertExplorationDatabaseIntegrity(backupDb);
      if (explorationStorageFingerprint(backupDb) !== fingerprint) {
        throw new Error('Backup differs from the inspected database');
      }
      inspectExplorationStorage(backupDb);
    } finally {
      backupDb.close();
    }
    transitionExplorationStorage(db, fingerprint, mode);
  }
  process.stdout.write(
    `${JSON.stringify({ mode, fingerprint, before, after: inspectExplorationStorage(db), resultFingerprint: explorationStorageFingerprint(db), ...(readOnly ? {} : { backupPath }) })}\n`
  );
} finally {
  db.close();
}
