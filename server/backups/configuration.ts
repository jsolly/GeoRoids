import { isAbsolute, parse, resolve } from 'node:path';
import process from 'node:process';

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/u;

export interface BackupConfiguration {
  bucket: string;
  region: string;
  stagingDirectory: string;
}

export function readBackupConfiguration(
  env: NodeJS.ProcessEnv = process.env
): BackupConfiguration | undefined {
  const enabled = env['GEOROIDS_BACKUP_ENABLED'];
  if (enabled === undefined || enabled === '0') {
    return undefined;
  }
  if (enabled !== '1') {
    throw new Error('GEOROIDS_BACKUP_ENABLED must be 0 or 1');
  }
  const { bucket, region } = readBackupDestination(env);
  const stagingDirectory = env['GEOROIDS_BACKUP_STAGING'];
  if (
    !stagingDirectory ||
    !isAbsolute(stagingDirectory) ||
    resolve(stagingDirectory) === parse(stagingDirectory).root
  ) {
    throw new Error('Backups require an absolute staging directory');
  }
  // No custom endpoint or public destination fallback is accepted in production.
  return { bucket, region, stagingDirectory };
}

/** Read-only download tools select the same explicit private destination, without enabling scheduling. */
export function readBackupDestination(
  env: NodeJS.ProcessEnv = process.env
): Pick<BackupConfiguration, 'bucket' | 'region'> {
  const bucket = env['GEOROIDS_BACKUP_BUCKET'];
  const region = env['GEOROIDS_BACKUP_REGION'];
  if (!bucket || !BUCKET.test(bucket) || bucket.includes('..')) {
    throw new Error('Backups require an explicit private S3 bucket');
  }
  if (!region || !REGION.test(region)) {
    throw new Error('Backups require an explicit AWS region');
  }
  return { bucket, region };
}
