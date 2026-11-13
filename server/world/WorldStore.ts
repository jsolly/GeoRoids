import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validCooperativeRecord } from '../../shared/cooperativeWorld';
import { validExploration } from '../../shared/exploration';
import { flightReturnWindowOpen } from '../../shared/playerMotion';
import { isShipKitId } from '../../shared/shipKits';
import { parseSectorId, WORLD } from '../../shared/world';
import type {
  AsteroidData,
  EquipmentId,
  Position,
  SavedPointLoot,
  SettlementState,
  ShipKitId,
  Velocity,
} from '../../shared-types';
import { readCooperativeWorld } from './cooperativeSchema';
import { readExplorationStorage } from './explorationSchema';
import { readSavedWorld, type SavedWorld } from './savedWorld';
import { readSavedEconomy, readSavedPilot, readSavedSector } from './worldDataValidation';
import type {
  ExplorationCheckpoint,
  LoadedWorld,
  WorldCheckpoint,
  WorldOpenIntent,
} from './worldPersistence';

/** Browser credential plus the saved score and optional recent flight. */
export interface PersistentPilot {
  silk?: number;
  equipment?: EquipmentId[];
  id: string;
  tokenHash: string;
  name: string;
  score: number;
  cargo?: number;
  purchases?: string[];
  /** Catalog hull color bought at Town Square. */
  hullColor?: string;
  lastSeenAt?: number;
  kitId?: ShipKitId;
  position?: Position;
  velocity?: Velocity;
  angle?: number;
  mass?: number;
  health?: number;
  /** Remaining recovery wait at lastSeenAt, in simulation frames. */
  healthRegenTimer?: number;
  shieldFrames?: number;
  shieldCooldownFrames?: number;
  /** Server release that issued the current token digest. */
  credentialReleaseId?: string;
  /** Client release present when the current token digest was issued. */
  credentialClientReleaseId?: string;
  /** Server clock when the current token digest was issued. */
  credentialIssuedAt?: number;
  /** Server release that last wrote `score`. */
  scoreReleaseId?: string;
  /** Client release present for a live score write. Omitted for server-only writes. */
  scoreClientReleaseId?: string;
  /** Server clock when `score` was last written. */
  scoreUpdatedAt?: number;
  /** Client release from the most recent join that reached this row. */
  lastClientReleaseId?: string;
}

/** Flight fields that a brief disconnect may restore. Missing `lastSeenAt` never restores pose. */
export interface RestorableFlight extends PersistentPilot {
  lastSeenAt: number;
  kitId: ShipKitId;
  position: Position;
  angle: number;
  mass: number;
  health: number;
}

export interface SavedEconomy {
  settlement: SettlementState;
  pointLoot: SavedPointLoot[];
}

export function restorableFlight(
  pilot: PersistentPilot,
  now: number
): RestorableFlight | undefined {
  const lastSeenAt = pilot.lastSeenAt;
  const kitId = pilot.kitId;
  const position = pilot.position;
  const angle = pilot.angle;
  const mass = pilot.mass;
  const health = pilot.health;
  if (
    lastSeenAt === undefined ||
    (!flightReturnWindowOpen(lastSeenAt, now) && (pilot.cargo ?? 0) === 0) ||
    !isShipKitId(kitId) ||
    position === undefined ||
    angle === undefined ||
    mass === undefined ||
    health === undefined ||
    health <= 0
  ) {
    return undefined;
  }
  return {
    ...pilot,
    lastSeenAt,
    kitId,
    position,
    angle,
    mass,
    health,
  };
}

/**
 * Single-writer SQLite transactions keep cargo consumption, shared scores and
 * discoveries together.
 *
 * Opening validates saved progress before writable setup and indexes sectors so
 * the write path can refuse duplicate asteroids across sectors. The store itself
 * is synchronous; a `WorldPersistence` adapter decides which thread it runs on.
 */
export class WorldStore {
  private readonly db: DatabaseSync;
  private readonly pilotJson = new Map<string, string>();
  /** Asteroid id → the sector row it is saved in; the duplicate-deposit guard. */
  private readonly persistedAsteroidSectors = new Map<string, string>();
  /** Sector id → the asteroid ids in its saved row, so a rewrite re-indexes only that row. */
  private readonly persistedSectorRocks = new Map<string, string[]>();
  /** Rows parsed while opening, handed over once by `loadSectors` and then released. */
  private openedSectors: Map<string, AsteroidData[]> | undefined;
  private worldJson: string | undefined;

  constructor(path: string, options: { intent?: WorldOpenIntent } = {}) {
    const intent = options.intent ?? (path === ':memory:' ? 'private' : 'existing');
    const fresh = path === ':memory:' || (intent === 'private' && !existsSync(path));
    if (fresh && path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, 'wx', 0o600));
    }
    if (!fresh) {
      // Refuse incompatible saved progress before writable setup can change even
      // journal mode. A missing production file never creates an empty world.
      const preflight = new DatabaseSync(path, { readOnly: true });
      try {
        preflight.exec('BEGIN');
        this.validateRuntimeStorage(preflight, intent);
      } finally {
        if (preflight.isTransaction) {
          preflight.exec('ROLLBACK');
        }
        preflight.close();
      }
    }
    this.db = new DatabaseSync(path);
    try {
      if (fresh) {
        this.db.exec(`CREATE TABLE world (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
          CREATE TABLE sectors (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE economy (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
          CREATE TABLE pilots (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE exploration (id TEXT PRIMARY KEY, bits TEXT NOT NULL);`);
      } else {
        this.validateRuntimeStorage(this.db, intent);
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;`);
      this.openedSectors = this.indexPersistedSectors();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private validateRuntimeStorage(db: DatabaseSync, intent: WorldOpenIntent): void {
    for (const table of ['world', 'sectors', 'economy', 'pilots']) {
      const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all();
      if (
        !columns.some(
          (c) =>
            c['name'] === 'id' &&
            c['pk'] === 1 &&
            c['type'] === (table === 'world' || table === 'economy' ? 'INTEGER' : 'TEXT')
        ) ||
        !columns.some((c) => c['name'] === 'json' && c['type'] === 'TEXT' && c['notnull'] === 1)
      ) {
        throw new Error('Unsupported saved world schema');
      }
    }
    const storage = readExplorationStorage(db);
    if (storage.state !== 'active') {
      throw new Error(
        `Exploration storage activation required: ${storage.state}; use the reviewed stopped-world transition`
      );
    }
    if (storage.world && storage.world.generation !== WORLD.generation) {
      throw new Error('Saved world generation is incompatible; refusing to reset player progress');
    }
    const cooperative = readCooperativeWorld(db);
    const rockIds = new Set<string>();
    let rows = 0;
    for (const row of db.prepare('SELECT id,json FROM sectors').iterate()) {
      if (typeof row['id'] !== 'string') {
        throw new Error('Invalid saved sector identity');
      }
      for (const rock of readSavedSector(row['id'], JSON.parse(String(row['json'])))) {
        if (rockIds.has(rock.id)) {
          throw new Error(`Saved asteroid ${rock.id} appears in sectors more than once`);
        }
        rockIds.add(rock.id);
      }
      rows++;
    }
    for (const row of db.prepare('SELECT id,json FROM pilots').iterate()) {
      const pilot = readSavedPilot(JSON.parse(String(row['json'])));
      if (!pilot || pilot.id !== row['id']) {
        throw new Error('Saved pilot is invalid; refusing to replace player progress');
      }
      rows++;
    }
    const economy = db.prepare('SELECT id,json FROM economy').all();
    if (economy.length > 1 || (economy[0] && economy[0]['id'] !== 1)) {
      throw new Error('Invalid saved economy identity');
    }
    readSavedEconomy(economy[0] ? JSON.parse(String(economy[0]['json'])) : {});
    if (
      !storage.world &&
      (intent !== 'private' ||
        rows > 0 ||
        economy.length > 0 ||
        storage.exploration.length > 0 ||
        cooperative !== undefined)
    ) {
      throw new Error('Saved progress has no world identity; refusing to create an empty world');
    }
  }

  /** Record a sector row in the duplicate-deposit index; the caller has checked for conflicts. */
  private indexSector(id: string, rocks: readonly AsteroidData[]): void {
    for (const rockId of this.persistedSectorRocks.get(id) ?? []) {
      if (this.persistedAsteroidSectors.get(rockId) === id) {
        this.persistedAsteroidSectors.delete(rockId);
      }
    }
    this.persistedSectorRocks.set(
      id,
      rocks.map((rock) => rock.id)
    );
    for (const rock of rocks) {
      this.persistedAsteroidSectors.set(rock.id, id);
    }
  }

  /**
   * Refuse a batch that would save one asteroid under two sectors, whether
   * both rows are in the batch or one is already on disk and not being
   * rewritten. Costs the size of the batch, not of the world.
   */
  private assertNoDuplicateDeposits(sectors: ReadonlyArray<[string, AsteroidData[]]>): void {
    const rewritten = new Set(sectors.map(([id]) => id));
    const inBatch = new Map<string, string>();
    for (const [id, rocks] of sectors) {
      for (const rock of rocks) {
        const other = inBatch.get(rock.id) ?? this.persistedAsteroidSectors.get(rock.id);
        if (
          other !== undefined &&
          other !== id &&
          (inBatch.has(rock.id) || !rewritten.has(other))
        ) {
          throw new Error(`Saved asteroid ${rock.id} appears in sectors ${other} and ${id}`);
        }
        inBatch.set(rock.id, id);
      }
    }
  }

  /** Parse, validate and index every saved sector row. */
  private indexPersistedSectors(): Map<string, AsteroidData[]> {
    this.persistedAsteroidSectors.clear();
    this.persistedSectorRocks.clear();
    const opened = new Map<string, AsteroidData[]>();
    for (const row of this.db.prepare('SELECT id,json FROM sectors').all()) {
      const id = row['id'];
      if (typeof id !== 'string') {
        throw new Error('Saved sector has an invalid identity');
      }
      let value: unknown;
      try {
        value = JSON.parse(String(row['json']));
      } catch (error) {
        throw new Error(`Saved sector ${id} is not valid JSON`, {
          cause: error,
        });
      }
      const rocks = readSavedSector(id, value);
      for (const rock of rocks) {
        const other = this.persistedAsteroidSectors.get(rock.id);
        if (other !== undefined && other !== id) {
          throw new Error(`Saved asteroid ${rock.id} appears in sectors ${other} and ${id}`);
        }
      }
      this.indexSector(id, rocks);
      opened.set(id, rocks);
    }
    return opened;
  }

  loadWorld(): SavedWorld | undefined {
    const row = this.db.prepare('SELECT json FROM world WHERE id=1').get();
    if (!row) {
      return undefined;
    }
    this.worldJson = String(row['json']);
    const storage = readExplorationStorage(this.db);
    if (storage.state !== 'active') {
      throw new Error('Exploration storage activation required');
    }
    return storage.world;
  }

  loadPilots(): PersistentPilot[] {
    return this.db
      .prepare('SELECT json FROM pilots')
      .all()
      .map((row) => {
        const value: unknown = JSON.parse(String(row['json']));
        const pilot = readSavedPilot(value);
        if (!pilot) {
          throw new Error('Saved pilot is invalid; refusing to replace player progress');
        }
        this.pilotJson.set(pilot.id, String(row['json']));
        return pilot;
      });
  }

  /**
   * Every saved sector. The rows parsed while opening are handed over once
   * and the store drops its copy, so the world lives in memory exactly once.
   * After that, or after any `checkpoint` or `reset`, the database is read
   * again, so an in-process restart always sees what is on disk.
   */
  loadSectors(): Map<string, AsteroidData[]> {
    const sectors = this.openedSectors ?? this.indexPersistedSectors();
    this.openedSectors = undefined;
    return sectors;
  }

  load(): LoadedWorld {
    const row = this.db.prepare('SELECT json FROM economy WHERE id=1').get();
    const saved: unknown = row ? JSON.parse(String(row['json'])) : {};
    const cooperative = readCooperativeWorld(this.db);
    const economy = readSavedEconomy(saved);
    const storage = readExplorationStorage(this.db);
    if (storage.state !== 'active') {
      throw new Error('Exploration storage activation required');
    }
    this.worldJson = this.db
      .prepare('SELECT json FROM world WHERE id=1')
      .get()
      ?.['json']?.toString();
    return {
      ...(cooperative ? { cooperative } : {}),
      economy,
      world: storage.world,
      exploration: storage.exploration,
      pilots: this.loadPilots(),
      sectors: this.loadSectors(),
    };
  }

  /** One saved row, for tests and tooling; the server reads the world once through `load`. */
  loadSector(id: string): AsteroidData[] | undefined {
    if (parseSectorId(id) === null) {
      throw new Error(`Invalid sector identity ${id}`);
    }
    const row = this.db.prepare('SELECT json FROM sectors WHERE id=?').get(id);
    if (!row) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(String(row['json']));
    } catch (error) {
      throw new Error(`Saved sector ${id} is not valid JSON`, { cause: error });
    }
    return readSavedSector(id, value);
  }

  /**
   * Commit one batch of changed rows. `world` is omitted when the world row
   * did not change; unchanged pilot rows are skipped by content.
   */
  checkpoint(
    world: SavedWorld | undefined,
    sectors: ReadonlyMap<string, AsteroidData[]>,
    pilots: readonly PersistentPilot[],
    economy?: SavedEconomy,
    cooperative?: WorldCheckpoint['cooperative'],
    exploration?: ExplorationCheckpoint
  ): void {
    const tiles = exploration ? Array.from(exploration.tiles, ([id, bits]) => ({ id, bits })) : [];
    if (!validExploration(tiles)) {
      throw new Error('Invalid exploration checkpoint');
    }
    if (world) {
      readSavedWorld(world);
      if ('exploration' in world || world.generation !== WORLD.generation) {
        throw new Error('Invalid world metadata checkpoint');
      }
    }
    const validatedSectors = [...sectors].map(([id, rocks]): [string, AsteroidData[]] => [
      id,
      readSavedSector(id, rocks),
    ]);
    this.assertNoDuplicateDeposits(validatedSectors);
    const worldJson = world === undefined ? undefined : JSON.stringify(world);
    const changedPilots = pilots
      .map((pilot) => ({ id: pilot.id, json: JSON.stringify(pilot) }))
      .filter((pilot) => this.pilotJson.get(pilot.id) !== pilot.json);
    if (cooperative) {
      const marker = this.db.prepare('SELECT version,activated FROM cooperative_schema').get();
      if (marker?.['version'] !== 1 || marker['activated'] !== 1) {
        throw new Error('Cooperative world is not activated');
      }
      for (const row of cooperative.records) {
        if (!validCooperativeRecord(row)) {
          throw new Error('Invalid cooperative checkpoint');
        }
      }
      if (
        new Set(cooperative.records.map((row) => `${row.kind}:${row.id}`)).size !==
          cooperative.records.length ||
        cooperative.removed.some((id) => !id.startsWith('downed:'))
      ) {
        throw new Error('Invalid cooperative identities');
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (cooperative) {
        const write = this.db.prepare(
          'INSERT OR REPLACE INTO cooperative_records(id,json) VALUES(?,?)'
        );
        for (const row of cooperative.records) {
          write.run(`${row.kind}:${row.id}`, JSON.stringify(row));
        }
        const remove = this.db.prepare('DELETE FROM cooperative_records WHERE id=?');
        for (const id of cooperative.removed) {
          remove.run(id);
        }
      }
      if (world && worldJson !== undefined && this.worldJson !== worldJson) {
        if (this.db.prepare('SELECT 1 FROM world WHERE id=1').get()) {
          // SQLite edits only owned paths; opaque integers/overflow numbers and
          // extra columns never round-trip through JavaScript or REPLACE.
          const owned = [
            'seed',
            'startedAt',
            'generation',
            'civicModules',
            'asteroidBelt',
            'writtenReleaseId',
          ];
          const present = owned.filter((key) => Object.hasOwn(world, key));
          const absent = owned.filter((key) => !Object.hasOwn(world, key));
          let expression = `json_set(json,${present.map((key) => `'$.${key}',json_extract(?,'$.${key}')`).join(',')})`;
          if (absent.length > 0) {
            expression = `json_remove(${expression},${absent.map((key) => `'$.${key}'`).join(',')})`;
          }
          this.db
            .prepare(`UPDATE world SET json=${expression} WHERE id=1`)
            .run(...present.map(() => worldJson));
        } else {
          this.db.prepare('INSERT INTO world(id,json) VALUES(1,?)').run(worldJson);
        }
      }
      if (exploration?.kind === 'replace') {
        this.db.exec('DELETE FROM exploration');
      }
      if (tiles.length > 0) {
        const write = this.db.prepare(
          'INSERT INTO exploration(id,bits) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET bits=excluded.bits'
        );
        for (const tile of tiles) {
          write.run(tile.id, tile.bits);
        }
      }
      if (economy) {
        this.db
          .prepare('INSERT OR REPLACE INTO economy(id,json) VALUES(1,?)')
          .run(JSON.stringify(economy));
      }
      const sectorWrite = this.db.prepare('INSERT OR REPLACE INTO sectors(id,json) VALUES(?,?)');
      for (const [id, rocks] of validatedSectors) {
        sectorWrite.run(id, JSON.stringify(rocks));
      }
      const pilotWrite = this.db.prepare('INSERT OR REPLACE INTO pilots(id,json) VALUES(?,?)');
      for (const pilot of changedPilots) {
        pilotWrite.run(pilot.id, pilot.json);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }
    if (worldJson !== undefined) {
      this.worldJson = worldJson;
    }
    for (const [id, rocks] of validatedSectors) {
      this.indexSector(id, rocks);
    }
    for (const pilot of changedPilots) {
      this.pilotJson.set(pilot.id, pilot.json);
    }
    // Rows parsed at open time no longer describe the database.
    this.openedSectors = undefined;
  }

  reset(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (readCooperativeWorld(this.db)) {
        this.db.exec('DELETE FROM cooperative_records; UPDATE cooperative_schema SET activated=0;');
      }
      this.db.exec(
        'DELETE FROM sectors; DELETE FROM pilots; DELETE FROM world; DELETE FROM economy; DELETE FROM exploration;'
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }
    this.persistedAsteroidSectors.clear();
    this.persistedSectorRocks.clear();
    this.openedSectors = undefined;
    this.pilotJson.clear();
    this.worldJson = undefined;
  }

  /**
   * SQLite rolls a transaction back by itself on a full disk, an I/O error or
   * a busy lock; asking again would throw "no transaction is active" from the
   * catch block and replace the error that explains the failure.
   */
  private rollback(): void {
    if (this.db.isTransaction) {
      this.db.exec('ROLLBACK');
    }
  }

  close(): void {
    this.db.close();
  }
}
