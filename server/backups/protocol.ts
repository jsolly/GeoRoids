import type { SnapshotReceipt } from './snapshot';

export type BackupStage =
  | 'staging'
  | 'snapshot'
  | 'daily_write'
  | 'daily_verify'
  | 'weekly_write'
  | 'weekly_verify'
  | 'cleanup';
export interface BackupReport {
  day: string;
  daily: SnapshotReceipt;
  weekly: SnapshotReceipt;
}
export type BackupWorkerMessage =
  | { kind: 'verified'; receipt: BackupReport }
  | { kind: 'failed'; stage: BackupStage };

export class BackupJobError extends Error {
  constructor(
    readonly stage: BackupStage,
    options: ErrorOptions
  ) {
    super(`World backup failed during ${stage}`, options);
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function receipt(value: unknown): value is SnapshotReceipt {
  return (
    record(value) &&
    typeof value['sha256'] === 'string' &&
    SHA256.test(value['sha256']) &&
    typeof value['worldIdentity'] === 'string' &&
    SHA256.test(value['worldIdentity']) &&
    ['bytes', 'generation', 'sectors', 'pilots', 'explorationTiles', 'cooperativeRecords'].every(
      (key) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0
    )
  );
}
function isStage(value: unknown): value is BackupStage {
  return (
    value === 'staging' ||
    value === 'snapshot' ||
    value === 'daily_write' ||
    value === 'daily_verify' ||
    value === 'weekly_write' ||
    value === 'weekly_verify' ||
    value === 'cleanup'
  );
}

/** Worker IPC is parsed before its safe receipts enter the server's operator log. */
export function readBackupWorkerMessage(value: unknown): BackupWorkerMessage | undefined {
  if (!record(value)) {
    return undefined;
  }
  if (value['kind'] === 'failed' && isStage(value['stage'])) {
    return { kind: 'failed', stage: value['stage'] };
  }
  const report = value['receipt'];
  if (
    value['kind'] === 'verified' &&
    record(report) &&
    typeof report['day'] === 'string' &&
    DAY.test(report['day']) &&
    receipt(report['daily']) &&
    receipt(report['weekly'])
  ) {
    const safeReceipt = (verified: SnapshotReceipt): SnapshotReceipt => ({
      sha256: verified.sha256,
      worldIdentity: verified.worldIdentity,
      bytes: verified.bytes,
      generation: verified.generation,
      sectors: verified.sectors,
      pilots: verified.pilots,
      explorationTiles: verified.explorationTiles,
      cooperativeRecords: verified.cooperativeRecords,
    });
    return {
      kind: 'verified',
      receipt: {
        day: report['day'],
        daily: safeReceipt(report['daily']),
        weekly: safeReceipt(report['weekly']),
      },
    };
  }
  return undefined;
}
