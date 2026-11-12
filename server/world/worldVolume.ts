import fs from 'node:fs';
import { dirname } from 'node:path';
import type { WorldVolumeDiagnostics } from './worldPersistence';

/** Warn 128 MiB before the debug-report store's 256 MiB free-space reserve. */
const LOW_VOLUME_BYTES = 384 * 1024 * 1024;

/** Only the writer thread calls this: health and simulation read its cached reply. */
export function sampleWorldVolume(
  path: string
): Exclude<WorldVolumeDiagnostics, { status: 'pending' }> {
  const sampledAt = Date.now();
  try {
    const volume = fs.statfsSync(dirname(path));
    const freeBytes = volume.bavail * volume.bsize;
    const databaseBytes = fs.statSync(path).size;
    const walBytes = fs.statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0;
    if (
      ![freeBytes, databaseBytes, walBytes].every(
        (bytes) => Number.isSafeInteger(bytes) && bytes >= 0
      )
    ) {
      return { status: 'unavailable', sampledAt, errorCode: 'INVALID_BYTE_COUNTS' };
    }
    return {
      status: freeBytes < LOW_VOLUME_BYTES ? 'low' : 'ok',
      sampledAt,
      freeBytes,
      databaseBytes,
      walBytes,
      warningBytes: LOW_VOLUME_BYTES,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      sampledAt,
      errorCode:
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN',
    };
  }
}
