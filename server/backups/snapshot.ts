import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, open, stat } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { WORLD } from '../../shared/world';
import { iterateCooperativeRecords, readCooperativeSchema } from '../world/cooperativeSchema';
import {
  assertExplorationDatabaseIntegrity,
  inspectExplorationStorage,
} from '../world/explorationSchema';
import { readSavedEconomy, readSavedPilot, readSavedSector } from '../world/worldDataValidation';

export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

/** No values from saved rows belong in a receipt or an operator log. */
export interface SnapshotReceipt {
  sha256: string;
  worldIdentity: string;
  bytes: number;
  generation: number;
  sectors: number;
  pilots: number;
  explorationTiles: number;
  cooperativeRecords: number;
}

function assertSnapshotSizeBound(db: DatabaseSync): number {
  const pages = db.prepare('PRAGMA page_count').get()?.['page_count'];
  const pageSize = db.prepare('PRAGMA page_size').get()?.['page_size'];
  if (
    typeof pages !== 'number' ||
    typeof pageSize !== 'number' ||
    pages * pageSize > MAX_BACKUP_BYTES
  ) {
    throw new Error('World exceeds backup size bound');
  }
  return pageSize;
}

function worldIdentity(seed: number, startedAt: number, generation: number): string {
  return createHash('sha256')
    .update(JSON.stringify([seed, startedAt, generation]))
    .digest('hex');
}

/** SQLite extracts only immutable identity fields, without a second JS atlas. */
function savedIdentity(db: DatabaseSync): Pick<SnapshotReceipt, 'worldIdentity' | 'generation'> {
  const row = db
    .prepare(
      "SELECT json_extract(json,'$.seed') AS seed, json_extract(json,'$.startedAt') AS startedAt, json_extract(json,'$.generation') AS generation FROM world WHERE id=1"
    )
    .get();
  const seed = row?.['seed'];
  const startedAt = row?.['startedAt'];
  const generation = row?.['generation'];
  if (
    typeof seed !== 'number' ||
    !Number.isFinite(seed) ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    generation !== WORLD.generation
  ) {
    throw new Error('Source world identity or generation is invalid or would reset on boot');
  }
  return { worldIdentity: worldIdentity(seed, startedAt, generation), generation };
}

export function sourceWorldIdentity(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    assertSnapshotSizeBound(db);
    return savedIdentity(db).worldIdentity;
  } finally {
    db.close();
  }
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('Expected saved JSON text');
  }
  return JSON.parse(value);
}

/** Reads existing tables only. Never opens WorldStore, creates schema or rewrites rows. */
function validateSnapshot(db: DatabaseSync): Omit<SnapshotReceipt, 'sha256' | 'bytes'> {
  assertExplorationDatabaseIntegrity(db);
  for (const table of ['world', 'sectors', 'economy', 'pilots']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (
      columns.length !== 2 ||
      columns[0]?.['name'] !== 'id' ||
      columns[0]?.['pk'] !== 1 ||
      columns[0]?.['type'] !== (table === 'world' || table === 'economy' ? 'INTEGER' : 'TEXT') ||
      columns[1]?.['name'] !== 'json' ||
      columns[1]?.['type'] !== 'TEXT' ||
      columns[1]?.['notnull'] !== 1
    ) {
      throw new Error('Unsupported world table schema');
    }
  }
  const worldRows = db.prepare('SELECT id FROM world LIMIT 2').all();
  const row = worldRows[0];
  if (worldRows.length !== 1 || row?.['id'] !== 1) {
    throw new Error('Backup requires one initialized world');
  }
  // The format owner validates metadata once, chooses the legacy atlas for
  // prepared/stale copies and uses tile rows only after explicit activation.
  const exploration = inspectExplorationStorage(db);
  const identity = savedIdentity(db);
  let sectors = 0;
  const asteroidIds = new Set<string>();
  for (const sector of db.prepare('SELECT id,json FROM sectors').iterate()) {
    const id = sector['id'];
    if (typeof id !== 'string') {
      throw new Error('Invalid sector identity');
    }
    for (const rock of readSavedSector(id, json(sector['json']))) {
      if (asteroidIds.has(rock.id)) {
        throw new Error('Duplicate saved asteroid');
      }
      asteroidIds.add(rock.id);
    }
    sectors++;
  }
  let pilots = 0;
  for (const pilotRow of db.prepare('SELECT id,json FROM pilots').iterate()) {
    const pilot = readSavedPilot(json(pilotRow['json']));
    if (!pilot || pilot.id !== pilotRow['id']) {
      throw new Error('Invalid pilot row or identity');
    }
    pilots++;
  }
  const economy = db.prepare('SELECT id,json FROM economy LIMIT 2').all();
  if (economy.length > 1 || (economy.length === 1 && economy[0]?.['id'] !== 1)) {
    throw new Error('Invalid economy identity');
  }
  readSavedEconomy(economy[0] ? json(economy[0]['json']) : {});
  let cooperativeRecords = 0;
  if (readCooperativeSchema(db) !== undefined) {
    for (const _record of iterateCooperativeRecords(db)) {
      cooperativeRecords++;
    }
  }
  return {
    ...identity,
    sectors,
    pilots,
    explorationTiles: exploration.tiles,
    cooperativeRecords,
  };
}

async function assertSelfContainedArtifact(path: string): Promise<void> {
  for (const suffix of ['-wal', '-journal']) {
    try {
      if ((await stat(`${path}${suffix}`)).size !== 0) {
        throw new Error('Artifact has a pending SQLite journal; take an online snapshot first');
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export async function inspectSnapshot(path: string): Promise<SnapshotReceipt> {
  await assertSelfContainedArtifact(path);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_BACKUP_BYTES) {
    throw new Error('Backup size outside configured bound');
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  let domain: Omit<SnapshotReceipt, 'sha256' | 'bytes'>;
  try {
    assertSnapshotSizeBound(db);
    domain = validateSnapshot(db);
  } finally {
    db.close();
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  await assertSelfContainedArtifact(path);
  return { ...domain, sha256: hash.digest('hex'), bytes: info.size };
}

/** SQLite's online backup includes committed WAL pages and all auxiliary tables. */
export async function createSnapshot(
  sourcePath: string,
  destination: string
): Promise<SnapshotReceipt> {
  const reserved = await open(destination, 'wx', 0o600);
  await reserved.close();
  const source = new DatabaseSync(sourcePath, {
    readOnly: true,
    timeout: 1000,
  });
  try {
    const pageSize = assertSnapshotSizeBound(source);
    await backup(source, destination, {
      rate: 16,
      progress: ({ totalPages }) => {
        if (totalPages * pageSize > MAX_BACKUP_BYTES) {
          throw new Error('Growing world exceeds backup size bound');
        }
      },
    });
  } finally {
    source.close();
  }
  await chmod(destination, 0o600);
  return inspectSnapshot(destination);
}
