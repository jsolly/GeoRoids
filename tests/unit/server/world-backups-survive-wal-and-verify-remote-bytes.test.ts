/* @vitest-environment node */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, test } from 'vitest';
import { readBackupConfiguration } from '../../../server/backups/configuration';
import { backupSlots, downloadBackup, runBackup } from '../../../server/backups/s3Backup';
import { createSnapshot, inspectSnapshot } from '../../../server/backups/snapshot';
import { GameEngine } from '../../../server/core/GameEngine';
import {
  legacyWorldDigest,
  migrateCooperativeWorld,
} from '../../../server/world/cooperativeSchema';
import {
  explorationStorageFingerprint,
  inspectExplorationStorage,
  transitionExplorationStorage,
} from '../../../server/world/explorationSchema';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

const identity = createHash('sha256')
  .update(JSON.stringify([82, 10000, WORLD.generation]))
  .digest('hex');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-backup-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'volume', 'world.sqlite');
  const store = new WorldStore(path);
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('fixture-pilot', 'Fixture pilot', socket, { x: 0, y: 0 }, 'scout');
  const registration = engine.registerPilot(pilot, socket);
  if (!registration.ok) {
    throw new Error('Fixture pilot registration failed');
  }
  engine.removePlayer(pilot.id);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE future_private_state (id TEXT PRIMARY KEY, json TEXT NOT NULL);'
  );
  db.prepare('INSERT INTO future_private_state VALUES(?,?)').run('untouched', '{ "future": true }');
  const saved = JSON.parse(String(db.prepare('SELECT json FROM world').get()?.['json']));
  db.prepare('UPDATE world SET json=?').run(JSON.stringify({ ...saved, startedAt: 10000 }));
  cleanups.push(() => db.close());
  return { directory, path, db, token: registration.resumeToken };
}

async function objectStore(options: { loseFirstPutResponse?: boolean } = {}) {
  const objects = new Map<string, { bytes: Buffer; sha256: string }>();
  const puts: string[] = [];
  let corrupt = false;
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    void serve(req, res).catch((error: unknown) => {
      failures.push(error);
      res.destroy();
    });
  });
  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
    if (req.method === 'PUT') {
      expect(req.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /u);
      expect(req.headers['if-none-match']).toBe('*');
      expect(req.headers['x-amz-server-side-encryption']).toBe('AES256');
      if (objects.has(key)) {
        req.resume();
        res.writeHead(412, { 'content-type': 'application/xml' });
        res.end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const sha256 = req.headers['x-amz-meta-sha256'];
      if (typeof sha256 !== 'string') {
        throw new Error('Checksum metadata missing');
      }
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      objects.set(key, { bytes, sha256 });
      puts.push(key);
      if (options.loseFirstPutResponse === true && puts.length === 1) {
        res.destroy();
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(['<Error><Code>', 'AccessDenied', '</Code></Error>'].join(''));
      return;
    }
    res.writeHead(200, {
      'content-length': object.bytes.length,
      'x-amz-meta-sha256': object.sha256,
      'x-amz-server-side-encryption': 'AES256',
    });
    const bytes = Buffer.from(object.bytes);
    if (corrupt) {
      // application_id is valid SQLite metadata, so integrity checks alone cannot catch this change.
      bytes[68] = (bytes[68] ?? 0) ^ 1;
    }
    res.end(bytes);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Owned S3 fixture failed');
    }
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture port');
  }
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'fixture-only', secretAccessKey: 'fixture-only' },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 },
  });
  cleanups.push(() => client.destroy());
  return {
    client,
    puts,
    objects,
    corrupt: () => {
      corrupt = true;
    },
  };
}

test('online snapshot includes committed WAL, every auxiliary table and a resumable pilot after actual engine boot', async () => {
  const { directory, path, db, token } = fixture();
  migrateCooperativeWorld(db, legacyWorldDigest(db));
  const destination = join(directory, 'snapshot.sqlite');
  const receipt = await createSnapshot(path, destination);
  expect(receipt).toMatchObject({ generation: WORLD.generation, pilots: 1, cooperativeRecords: 0 });
  const before = readFileSync(destination);
  const restored = new DatabaseSync(destination, { readOnly: true });
  expect(restored.prepare('SELECT json FROM future_private_state').get()?.['json']).toBe(
    '{ "future": true }'
  );
  expect(restored.prepare('SELECT activated FROM cooperative_schema').get()?.['activated']).toBe(0);
  expect(legacyWorldDigest(restored)).toBe(legacyWorldDigest(db));
  restored.close();
  expect(await inspectSnapshot(destination)).toEqual(receipt);
  expect(readFileSync(destination)).toEqual(before);
  // Boot a second copy so rehearsal writes never alter the exact preserved artifact.
  const rehearsal = join(directory, 'rehearsal.sqlite');
  await createSnapshot(destination, rehearsal);
  const store = new WorldStore(rehearsal);
  try {
    const engine = new GameEngine(999, undefined, new InlineWorldPersistence(store));
    expect(engine.getTerrainSeed()).toBe(82);
    const resumed = engine.resumePilot(token, new RecordingSocket());
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      throw new Error('Restored pilot could not resume');
    }
    expect(resumed.actor.id).toBe('fixture-pilot');
    const laser = engine.spawnPlayerLaser(resumed.actor.id, resumed.actor.position, { x: 1, y: 0 });
    expect(laser?.ownerId).toBe('fixture-pilot');
    engine.removePlayer(resumed.actor.id);
    expect(store.loadPilots()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('online snapshots retain sparse row identities, opaque storage classes and sequence state without receipt leaks', async () => {
  const { directory, path, db, token } = fixture();
  db.exec(`
    CREATE TABLE sqliteAux (value);
    INSERT INTO sqliteAux(rowid,value) VALUES
      (11,NULL),(42,1),(43,1.0),(44,9223372036854775806),(45,9223372036854775807),
      (46,CAST(X'610062' AS TEXT)),(47,CAST(X'ff' AS TEXT)),(48,X'ff'),(49,1e999);
    CREATE TABLE future_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT, private TEXT);
    INSERT INTO future_sequence(id,private) VALUES(91,'private-sequence-marker');
    DELETE FROM future_sequence;
  `);
  const sourceBefore = explorationStorageFingerprint(db);
  const destination = join(directory, 'opaque.sqlite');
  const receipt = await createSnapshot(path, destination);
  expect(explorationStorageFingerprint(db)).toBe(sourceBefore);
  const copy = new DatabaseSync(destination);
  try {
    expect(explorationStorageFingerprint(copy)).toBe(sourceBefore);
    expect(
      copy
        .prepare(
          'SELECT rowid,typeof(value) AS kind,hex(CAST(value AS BLOB)) AS bytes FROM sqliteAux ORDER BY rowid'
        )
        .all()
    ).toEqual([
      { rowid: 11, kind: 'null', bytes: '' },
      { rowid: 42, kind: 'integer', bytes: '31' },
      { rowid: 43, kind: 'real', bytes: '312E30' },
      { rowid: 44, kind: 'integer', bytes: '39323233333732303336383534373735383036' },
      { rowid: 45, kind: 'integer', bytes: '39323233333732303336383534373735383037' },
      { rowid: 46, kind: 'text', bytes: '610062' },
      { rowid: 47, kind: 'text', bytes: 'FF' },
      { rowid: 48, kind: 'blob', bytes: 'FF' },
      { rowid: 49, kind: 'real', bytes: '496E66' },
    ]);
    expect(
      copy.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('future_sequence')
    ).toEqual({ seq: 91 });
    const fingerprints = new Set<string>();
    for (const scalar of [
      'NULL',
      '1',
      '1.0',
      '9223372036854775806',
      '9223372036854775807',
      "CAST(X'610062' AS TEXT)",
      "CAST(X'ff' AS TEXT)",
      "X'ff'",
      '1e999',
    ]) {
      copy.exec(`UPDATE sqliteAux SET value=${scalar} WHERE rowid=42`);
      fingerprints.add(explorationStorageFingerprint(copy));
    }
    expect(fingerprints.size).toBe(9);
  } finally {
    copy.close();
  }
  expect(Object.keys(receipt).sort((left, right) => left.localeCompare(right))).toEqual([
    'bytes',
    'cooperativeRecords',
    'explorationTiles',
    'generation',
    'pilots',
    'sectors',
    'sha256',
    'worldIdentity',
  ]);
  expect(JSON.stringify(receipt)).not.toContain(token);
  expect(JSON.stringify(receipt)).not.toContain('private-sequence-marker');
});

test('SQLite integrity alone cannot accept a malformed credential row or a reset-on-boot generation', async () => {
  const { directory, path, db } = fixture();
  db.prepare('UPDATE pilots SET json=?').run(
    '{"id":"fixture-pilot","tokenHash":"bad","name":"Fixture","score":0}'
  );
  expect(db.prepare('PRAGMA integrity_check').get()?.['integrity_check']).toBe('ok');
  await expect(createSnapshot(path, join(directory, 'invalid-pilot.sqlite'))).rejects.toThrow(
    'pilot'
  );
  db.exec('DELETE FROM pilots');
  const value = JSON.parse(String(db.prepare('SELECT json FROM world').get()?.['json']));
  db.prepare('UPDATE world SET json=?').run(
    JSON.stringify({ ...value, generation: WORLD.generation + 1 })
  );
  await expect(createSnapshot(path, join(directory, 'wrong-generation.sqlite'))).rejects.toThrow(
    'generation'
  );
});

test.each(['legacy', 'prepared', 'stale-preparation', 'active'] as const)(
  'a %s snapshot counts authoritative discoveries and preserves every source row',
  async (state) => {
    const { directory, path, db } = fixture();
    const atlas = [
      { id: '30,30', bits: `03${'00'.repeat(31)}` },
      { id: '7,12', bits: `${'00'.repeat(31)}80` },
    ];
    const world: unknown = JSON.parse(String(db.prepare('SELECT json FROM world').get()?.['json']));
    if (world === null || typeof world !== 'object') {
      throw new Error('Fixture world missing');
    }
    db.prepare('UPDATE world SET json=?').run(JSON.stringify({ ...world, exploration: atlas }));
    if (state !== 'legacy') {
      transitionExplorationStorage(db, explorationStorageFingerprint(db), 'prepare');
    }
    if (state === 'active') {
      transitionExplorationStorage(db, explorationStorageFingerprint(db), 'activate');
      db.prepare('INSERT INTO exploration(id,bits) VALUES(?,?)').run(
        '31,30',
        `04${'00'.repeat(31)}`
      );
    } else if (state === 'stale-preparation') {
      // The old writer reveals a third tile after preparation. Its legacy atlas
      // remains authoritative, even though the prepared table contains only two.
      db.prepare('UPDATE world SET json=?').run(
        JSON.stringify({
          ...world,
          exploration: [...atlas, { id: '31,30', bits: `04${'00'.repeat(31)}` }],
        })
      );
    }
    const expectedTiles = state === 'active' || state === 'stale-preparation' ? 3 : 2;
    expect(inspectExplorationStorage(db)).toEqual({ state, tiles: expectedTiles });
    const sourceBefore = explorationStorageFingerprint(db);
    const destination = join(directory, `${state}.sqlite`);
    const receipt = await createSnapshot(path, destination);
    expect(receipt).toMatchObject({
      worldIdentity: identity,
      pilots: 1,
      explorationTiles: expectedTiles,
    });
    expect(explorationStorageFingerprint(db)).toBe(sourceBefore);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(inspectExplorationStorage(copy)).toEqual({ state, tiles: expectedTiles });
      expect(explorationStorageFingerprint(copy)).toBe(sourceBefore);
    } finally {
      copy.close();
    }
    const bytes = readFileSync(destination);
    expect(await inspectSnapshot(destination)).toEqual(receipt);
    expect(readFileSync(destination)).toEqual(bytes);
  }
);

test('daily and weekly uploads verify real S3-compatible GET bytes and retries reuse the original UTC slots', async () => {
  const { directory, path } = fixture();
  const remote = await objectStore();
  const configuration = {
    bucket: 'fixture-private',
    region: 'us-east-1',
    stagingDirectory: join(directory, 'stage'),
  };
  const options = {
    configuration,
    worldPath: path,
    client: remote.client,
    now: new Date('2026-11-12T23:59:00Z'),
  };
  const first = await runBackup(options);
  expect(remote.puts).toEqual([
    `/fixture-private/daily/${identity}/2026-11-12.sqlite`,
    `/fixture-private/weekly/${identity}/2026-11-09.sqlite`,
  ]);
  expect(first.daily.sha256).toBe(first.weekly.sha256);
  expect(await runBackup(options)).toEqual(first);
  expect(remote.puts).toHaveLength(2);
  expect(readdirSync(configuration.stagingDirectory)).toEqual([]);
  remote.corrupt();
  await expect(runBackup(options)).rejects.toMatchObject({
    stage: 'daily_verify',
    cause: expect.objectContaining({ message: 'Remote backup bytes failed SHA256 verification' }),
  });
  expect(readdirSync(configuration.stagingDirectory)).toEqual([]);
});

test('configuration stays disabled and refuses incomplete activation; UTC week slots cross year boundaries', () => {
  expect(readBackupConfiguration({})).toBeUndefined();
  expect(() => readBackupConfiguration({ GEOROIDS_BACKUP_ENABLED: '1' })).toThrow('bucket');
  expect(() => readBackupConfiguration({ GEOROIDS_BACKUP_ENABLED: 'yes' })).toThrow('0 or 1');
  expect(backupSlots({ now: new Date('2027-01-01T00:00:00Z'), worldIdentity: identity })).toEqual({
    daily: `daily/${identity}/2027-01-01.sqlite`,
    weekly: `weekly/${identity}/2026-12-28.sqlite`,
  });
});

test('a lost PUT response leaves one immutable daily artifact and restart verifies it before creating the weekly slot', async () => {
  const { directory, path, db } = fixture();
  const remote = await objectStore({ loseFirstPutResponse: true });
  const configuration = {
    bucket: 'fixture-private',
    region: 'us-east-1',
    stagingDirectory: join(directory, 'stage'),
  };
  const options = {
    configuration,
    worldPath: path,
    client: remote.client,
    now: new Date('2026-11-12T00:00:00Z'),
  };
  await expect(runBackup(options)).rejects.toMatchObject({ stage: 'daily_write' });
  const original = remote.objects.get(`/fixture-private/daily/${identity}/2026-11-12.sqlite`);
  expect(original).toBeDefined();
  db.exec('DELETE FROM pilots');
  const retried = await runBackup(options);
  expect(retried.daily.pilots).toBe(1);
  expect(retried.daily.sha256).toBe(original?.sha256);
  expect(remote.puts).toHaveLength(2);
  expect(readdirSync(configuration.stagingDirectory)).toEqual([]);
});

test('a stale prepared exploration copy preserves the authoritative legacy atlas and all exact table bytes', async () => {
  const { directory, path, db } = fixture();
  db.exec('CREATE TABLE exploration (id TEXT PRIMARY KEY, bits TEXT NOT NULL)');
  db.prepare('INSERT INTO exploration VALUES(?,?)').run('31,30', `04${'00'.repeat(31)}`);
  const world = JSON.parse(String(db.prepare('SELECT json FROM world').get()?.['json']));
  const destination = join(directory, 'prepared.sqlite');
  const result = await createSnapshot(path, destination);
  expect(result.explorationTiles).toBe(world.exploration.length);
  const restored = new DatabaseSync(destination, { readOnly: true });
  try {
    expect(restored.prepare('SELECT json FROM world').get()).toEqual(
      db.prepare('SELECT json FROM world').get()
    );
    expect(restored.prepare('SELECT id,bits FROM exploration').all()).toEqual([
      { id: '31,30', bits: `04${'00'.repeat(31)}` },
    ]);
  } finally {
    restored.close();
  }
});

test('corrupted bytes returned immediately after upload fail before any weekly artifact or success receipt exists', async () => {
  const { directory, path } = fixture();
  const remote = await objectStore();
  remote.corrupt();
  await expect(
    runBackup({
      configuration: {
        bucket: 'fixture-private',
        region: 'us-east-1',
        stagingDirectory: join(directory, 'stage'),
      },
      worldPath: path,
      client: remote.client,
      now: new Date('2026-11-12T00:00:00Z'),
    })
  ).rejects.toMatchObject({ stage: 'daily_verify' });
  expect(remote.puts).toEqual([`/fixture-private/daily/${identity}/2026-11-12.sqlite`]);
});

test('selected restore download verifies the independent digest and refuses an existing destination without deleting it', async () => {
  const { directory, path } = fixture();
  const remote = await objectStore();
  const configuration = {
    bucket: 'fixture-private',
    region: 'us-east-1',
    stagingDirectory: join(directory, 'stage'),
  };
  const report = await runBackup({
    configuration,
    worldPath: path,
    client: remote.client,
    now: new Date('2026-11-12T00:00:00Z'),
  });
  const newDirectory = join(directory, 'selected');
  const selected = {
    destination: configuration,
    key: `daily/${identity}/2026-11-12.sqlite`,
    expectedSha256: report.daily.sha256,
    newDirectory,
    client: remote.client,
  };
  await expect(downloadBackup(selected)).resolves.toEqual(report.daily);
  expect(await inspectSnapshot(join(newDirectory, 'world.sqlite'))).toEqual(report.daily);
  await expect(downloadBackup(selected)).rejects.toThrow('EEXIST');
  expect(await inspectSnapshot(join(newDirectory, 'world.sqlite'))).toEqual(report.daily);
  const badDirectory = join(directory, 'wrong-digest');
  await expect(
    downloadBackup({ ...selected, newDirectory: badDirectory, expectedSha256: '0'.repeat(64) })
  ).rejects.toThrow('SHA256');
  expect(readdirSync(directory)).not.toContain('wrong-digest');
});

test('a new world identity gets independent daily and weekly slots during the same period', async () => {
  const firstWorld = fixture();
  const remote = await objectStore();
  const configuration = {
    bucket: 'fixture-private',
    region: 'us-east-1',
    stagingDirectory: join(firstWorld.directory, 'stage'),
  };
  const options = {
    configuration,
    worldPath: firstWorld.path,
    client: remote.client,
    now: new Date('2026-11-12T00:00:00Z'),
  };
  await runBackup(options);
  const secondWorld = fixture();
  const value = JSON.parse(
    String(secondWorld.db.prepare('SELECT json FROM world').get()?.['json'])
  );
  secondWorld.db.prepare('UPDATE world SET json=?').run(JSON.stringify({ ...value, seed: 12345 }));
  const second = await runBackup({
    ...options,
    worldPath: secondWorld.path,
    configuration: { ...configuration, stagingDirectory: join(secondWorld.directory, 'stage') },
  });
  expect(second.daily.worldIdentity).not.toBe(identity);
  expect(remote.puts).toHaveLength(4);
});

test('inspection cannot certify a live main file whose committed data still resides in WAL', async () => {
  const { path } = fixture();
  await expect(inspectSnapshot(path)).rejects.toThrow('pending SQLite journal');
});
