import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { BackupConfiguration } from './configuration';
import { BackupJobError, type BackupReport, type BackupStage } from './protocol';
import {
  createSnapshot,
  inspectSnapshot,
  MAX_BACKUP_BYTES,
  type SnapshotReceipt,
  sourceWorldIdentity,
} from './snapshot';

const BACKUP_KEY = /^(?:daily|weekly)\/[a-f0-9]{64}\/\d{4}-\d{2}-\d{2}\.sqlite$/u;
const JOB_DIRECTORY = /^job-(\d+)-[A-Za-z0-9]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/** Only tests supply a loopback S3 client. Production constructs the AWS SDK client below. */
async function downloadVerified(
  client: S3Client,
  bucket: string,
  key: string,
  path: string
): Promise<SnapshotReceipt> {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const expected = object.Metadata?.['sha256'];
  if (
    !(object.Body instanceof Readable) ||
    !expected ||
    !SHA256.test(expected) ||
    object.ServerSideEncryption !== 'AES256' ||
    !object.ContentLength ||
    object.ContentLength > MAX_BACKUP_BYTES
  ) {
    if (object.Body instanceof Readable) {
      object.Body.destroy();
    }
    throw new Error('Remote backup lacks required size, encryption or checksum');
  }
  let bytes = 0;
  const hash = createHash('sha256');
  await pipeline(
    object.Body,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_BACKUP_BYTES) {
          callback(new Error('Remote backup exceeds size bound'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(path, { flags: 'wx', mode: 0o600 })
  );
  if (bytes !== object.ContentLength || hash.digest('hex') !== expected) {
    throw new Error('Remote backup bytes failed SHA256 verification');
  }
  const receipt = await inspectSnapshot(path);
  if (receipt.sha256 !== expected) {
    throw new Error('Remote backup changed during validation');
  }
  return receipt;
}

async function upload(
  client: S3Client,
  bucket: string,
  key: string,
  path: string,
  receipt: SnapshotReceipt
): Promise<boolean> {
  const body = createReadStream(path);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: receipt.bytes,
        ContentType: 'application/vnd.sqlite3',
        ServerSideEncryption: 'AES256',
        ChecksumSHA256: Buffer.from(receipt.sha256, 'hex').toString('base64'),
        Metadata: { sha256: receipt.sha256 },
        IfNoneMatch: '*',
      })
    );
    return true;
  } catch (error) {
    // Another instance or a response-lost retry may already own this UTC slot.
    // Read and validate that artifact; never replace it with a newer snapshot.
    if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 412) {
      throw error;
    }
    return false;
  } finally {
    body.destroy();
  }
}

export function backupSlots(options: { now: Date; worldIdentity: string }): {
  daily: string;
  weekly: string;
} {
  const daily = options.now.toISOString().slice(0, 10);
  const monday = new Date(`${daily}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return {
    daily: `daily/${options.worldIdentity}/${daily}.sqlite`,
    weekly: `weekly/${options.worldIdentity}/${monday.toISOString().slice(0, 10)}.sqlite`,
  };
}

async function cleanAbandonedJobs(staging: string): Promise<void> {
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    const owner = JOB_DIRECTORY.exec(entry.name)?.[1];
    if (!entry.isDirectory() || owner === undefined) {
      continue;
    }
    try {
      process.kill(Number(owner), 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        await rm(join(staging, entry.name), { recursive: true });
      } else {
        throw error;
      }
    }
  }
}

/** Owns at most two bounded SQLite artifacts; the supervisor owns its total deadline. */
export async function runBackup(options: {
  configuration: BackupConfiguration;
  worldPath: string;
  now?: Date;
  client?: S3Client;
}): Promise<BackupReport> {
  const { configuration, worldPath } = options;
  const client =
    options.client ??
    new S3Client({
      region: configuration.region,
      maxAttempts: 2,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 },
    });
  let directory: string | undefined;
  let stage: BackupStage = 'staging';
  try {
    if (resolve(configuration.stagingDirectory) === dirname(resolve(worldPath))) {
      throw new Error('Backup staging must be a dedicated directory');
    }
    await mkdir(configuration.stagingDirectory, { recursive: true, mode: 0o700 });
    const stagingPath = await realpath(configuration.stagingDirectory);
    const worldDirectory = await realpath(dirname(worldPath));
    if (stagingPath === worldDirectory || stagingPath.startsWith(`${worldDirectory}${sep}`)) {
      throw new Error('Backup staging must be outside the source world directory');
    }
    await chmod(configuration.stagingDirectory, 0o700);
    await cleanAbandonedJobs(configuration.stagingDirectory);
    const space = await statfs(configuration.stagingDirectory);
    if (space.bavail * space.bsize < MAX_BACKUP_BYTES * 2 + 64 * 1024 * 1024) {
      throw new Error('Backup staging needs two snapshot bounds plus 64 MiB free');
    }
    directory = await mkdtemp(join(configuration.stagingDirectory, `job-${process.pid}-`));
    stage = 'snapshot';
    const expectedIdentity = sourceWorldIdentity(worldPath);
    const now = options.now ?? new Date();
    const slots = backupSlots({ now, worldIdentity: expectedIdentity });
    const dailyPath = join(directory, 'daily.sqlite');
    const snapshotPath = join(directory, 'snapshot.sqlite');
    const snapshot = await createSnapshot(worldPath, snapshotPath);
    if (snapshot.worldIdentity !== expectedIdentity) {
      throw new Error('Source world changed identity during backup');
    }
    // A missing GET is 403 without ListBucket permission. Create-only PUT first
    // avoids granting listing and never interprets access denial as absence.
    stage = 'daily_write';
    const dailyUploaded = await upload(
      client,
      configuration.bucket,
      slots.daily,
      snapshotPath,
      snapshot
    );
    stage = 'daily_verify';
    const daily = await downloadVerified(client, configuration.bucket, slots.daily, dailyPath);
    if (
      (dailyUploaded && daily.sha256 !== snapshot.sha256) ||
      daily.worldIdentity !== expectedIdentity
    ) {
      throw new Error('Daily slot does not match the expected artifact or world');
    }
    await rm(snapshotPath);
    const weeklyPath = join(directory, 'weekly.sqlite');
    stage = 'weekly_write';
    const weeklyUploaded = await upload(
      client,
      configuration.bucket,
      slots.weekly,
      dailyPath,
      daily
    );
    stage = 'weekly_verify';
    const weekly = await downloadVerified(client, configuration.bucket, slots.weekly, weeklyPath);
    if (
      (weeklyUploaded && weekly.sha256 !== daily.sha256) ||
      weekly.worldIdentity !== expectedIdentity
    ) {
      throw new Error('Weekly slot does not match the expected artifact or world');
    }
    return { daily, weekly, day: now.toISOString().slice(0, 10) };
  } catch (cause) {
    throw new BackupJobError(stage, { cause });
  } finally {
    if (!options.client) {
      client.destroy();
    }
    if (directory) {
      await cleanupJob(directory);
    }
  }
}

async function cleanupJob(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cause) {
    throw new BackupJobError('cleanup', { cause });
  }
}

/** Download one deliberately selected artifact into a new private directory. No live destination is accepted. */
export async function downloadBackup(options: {
  destination: Pick<BackupConfiguration, 'bucket' | 'region'>;
  key: string;
  expectedSha256: string;
  newDirectory: string;
  client?: S3Client;
}): Promise<SnapshotReceipt> {
  if (
    !BACKUP_KEY.test(options.key) ||
    !SHA256.test(options.expectedSha256) ||
    !isAbsolute(options.newDirectory)
  ) {
    throw new Error(
      'Download requires an exact daily/weekly key, reviewed SHA256 and absolute new directory'
    );
  }
  const client =
    options.client ??
    new S3Client({
      region: options.destination.region,
      maxAttempts: 2,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    });
  let owned = false;
  try {
    await mkdir(options.newDirectory, { mode: 0o700 });
    owned = true;
    const result = await downloadVerified(
      client,
      options.destination.bucket,
      options.key,
      join(options.newDirectory, 'world.sqlite')
    );
    if (
      result.sha256 !== options.expectedSha256 ||
      result.worldIdentity !== options.key.split('/')[1]
    ) {
      throw new Error('Selected backup does not match reviewed SHA256');
    }
    return result;
  } catch (error) {
    if (owned) {
      await cleanupJob(options.newDirectory);
    }
    throw error;
  } finally {
    if (!options.client) {
      client.destroy();
    }
  }
}
