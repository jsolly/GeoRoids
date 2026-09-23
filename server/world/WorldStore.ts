import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { epochField } from '../../shared/epochField';
import { validEquipment } from '../../shared/equipment';
import { validExploration } from '../../shared/exploration';
import { validCivicModules, validLitCivicLotIds } from '../../shared/furnaces';
import { finiteMotionVector, flightReturnWindowOpen } from '../../shared/playerMotion';
import { releaseField } from '../../shared/releaseId';
import { isShipBoostState } from '../../shared/shipBoost';
import { validateAsteroidDto } from '../../shared/snapshotDto';
import { purchasedHullColor } from '../../shared/townStore';
import { parseSectorId, sectorAt, WORLD } from '../../shared/world';
import type {
  AsteroidData,
  CivicModule,
  EquipmentId,
  ExplorationTile,
  Position,
  ShipBoostState,
  ShipKitId,
  Velocity,
} from '../../shared-types';
import { isShipKitId } from '../../src/entities/ship/shipKits';
import type { LoadedWorld } from './worldPersistence';

const PILOT_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function readCivicModules(value: object): CivicModule[] {
  if ('civicModules' in value) {
    if (!validCivicModules(value.civicModules)) {
      throw new Error('Saved street furnaces are invalid; refusing to replace player progress');
    }
    return value.civicModules;
  }
  if ('litCivicLotIds' in value) {
    if (!validLitCivicLotIds(value.litCivicLotIds)) {
      throw new Error('Saved street furnaces are invalid; refusing to replace player progress');
    }
    return value.litCivicLotIds.map((id) => ({ id, builderName: '' }));
  }
  return [];
}

function validSectorId(id: string): boolean {
  return parseSectorId(id) !== null;
}

function validWorldPosition(position: Position): boolean {
  return finiteMotionVector(position) && Math.hypot(position.x, position.y) <= WORLD.radius;
}

/** Browser credential plus the saved score and optional recent flight. */
export interface PersistentPilot {
  silk?: number;
  equipment?: EquipmentId[];
  id: string;
  tokenHash: string;
  name: string;
  score: number;
  /** Catalog hull color bought at Town Square. */
  hullColor?: string;
  lastSeenAt?: number;
  kitId?: ShipKitId;
  position?: Position;
  velocity?: Velocity;
  angle?: number;
  lives?: number;
  mass?: number;
  health?: number;
  boost?: ShipBoostState;
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
  lives: number;
  mass: number;
  health: number;
}

export interface SavedWorld {
  /** Street furnaces a Scout paid for. Absent on older rows. */
  civicModules?: CivicModule[];
  seed: number;
  startedAt: number;
  generation: number;
  /** Density schema for additive asteroid slots; absent in pre-migration worlds. */
  asteroidDensityVersion?: number;
  asteroidMotionVersion?: number;
  writtenReleaseId?: string;
  exploration: ExplorationTile[];
}

function readVector(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const vector = value as Record<string, unknown>;
  const x = vector['x'];
  const y = vector['y'];
  if (typeof x !== 'number' || typeof y !== 'number') {
    return undefined;
  }
  return { x, y };
}

function readOptionalFlight(
  pilot: Record<string, unknown>
): Omit<PersistentPilot, 'id' | 'tokenHash' | 'name' | 'score'> | undefined {
  if (!('lastSeenAt' in pilot)) {
    return undefined;
  }
  const lastSeenAt = pilot['lastSeenAt'];
  const position = readVector(pilot['position']);
  const angle = pilot['angle'];
  const lives = pilot['lives'];
  const mass = pilot['mass'];
  const health = pilot['health'];
  const kitId = pilot['kitId'];
  if (
    typeof lastSeenAt !== 'number' ||
    !Number.isFinite(lastSeenAt) ||
    lastSeenAt < 0 ||
    !position ||
    !validWorldPosition(position) ||
    typeof angle !== 'number' ||
    !Number.isFinite(angle) ||
    typeof lives !== 'number' ||
    !Number.isInteger(lives) ||
    lives < 0 ||
    lives > 99 ||
    typeof mass !== 'number' ||
    !Number.isFinite(mass) ||
    mass <= 0 ||
    typeof health !== 'number' ||
    !Number.isFinite(health) ||
    health < 0 ||
    !isShipKitId(kitId)
  ) {
    return undefined;
  }
  const velocity = readVector(pilot['velocity']);
  return {
    lastSeenAt,
    kitId,
    position,
    angle,
    lives,
    mass,
    health,
    ...(velocity && finiteMotionVector(velocity) ? { velocity } : {}),
  };
}

function readReleaseProvenance(
  pilot: Record<string, unknown>
): Pick<
  PersistentPilot,
  | 'credentialReleaseId'
  | 'credentialClientReleaseId'
  | 'credentialIssuedAt'
  | 'scoreReleaseId'
  | 'scoreClientReleaseId'
  | 'scoreUpdatedAt'
  | 'lastClientReleaseId'
> {
  return {
    ...releaseField('credentialReleaseId', pilot['credentialReleaseId']),
    ...releaseField('credentialClientReleaseId', pilot['credentialClientReleaseId']),
    ...epochField('credentialIssuedAt', pilot['credentialIssuedAt']),
    ...releaseField('scoreReleaseId', pilot['scoreReleaseId']),
    ...releaseField('scoreClientReleaseId', pilot['scoreClientReleaseId']),
    ...epochField('scoreUpdatedAt', pilot['scoreUpdatedAt']),
    ...releaseField('lastClientReleaseId', pilot['lastClientReleaseId']),
  };
}

function readPilot(value: unknown): PersistentPilot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const pilot = value as Record<string, unknown>;
  const id = pilot['id'];
  const name = pilot['name'];
  const tokenHash = pilot['tokenHash'];
  const score = pilot['score'];
  const equipment = pilot['equipment'];
  if (equipment !== undefined && !validEquipment(equipment)) {
    return undefined;
  }
  const silk = pilot['silk'];
  if (silk !== undefined && (typeof silk !== 'number' || !Number.isSafeInteger(silk) || silk < 0)) {
    return undefined;
  }
  const hullColor = pilot['hullColor'];
  if (hullColor !== undefined && typeof hullColor !== 'string') {
    return undefined;
  }
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof tokenHash !== 'string' ||
    !PILOT_TOKEN_HASH_PATTERN.test(tokenHash) ||
    typeof score !== 'number' ||
    !Number.isFinite(score)
  ) {
    return undefined;
  }
  return {
    id,
    tokenHash,
    name,
    score,
    ...(equipment !== undefined ? { equipment: [...equipment] } : {}),
    ...(typeof silk === 'number' ? { silk } : {}),
    ...(typeof hullColor === 'string' && purchasedHullColor(hullColor) ? { hullColor } : {}),
    ...readOptionalFlight(pilot),
    ...(isShipBoostState(pilot['boost']) ? { boost: { ...pilot['boost'] } } : {}),
    ...readReleaseProvenance(pilot),
  };
}

/** Restore pose only when last-seen is present, recent, and the ship still has lives. */
export function restorableFlight(
  pilot: PersistentPilot,
  now: number
): RestorableFlight | undefined {
  const lastSeenAt = pilot.lastSeenAt;
  const kitId = pilot.kitId;
  const position = pilot.position;
  const angle = pilot.angle;
  const lives = pilot.lives;
  const mass = pilot.mass;
  const health = pilot.health;
  if (
    lastSeenAt === undefined ||
    !flightReturnWindowOpen(lastSeenAt, now) ||
    !isShipKitId(kitId) ||
    position === undefined ||
    angle === undefined ||
    lives === undefined ||
    lives <= 0 ||
    mass === undefined ||
    health === undefined
  ) {
    return undefined;
  }
  return {
    ...pilot,
    lastSeenAt,
    kitId,
    position,
    angle,
    lives,
    mass,
    health,
  };
}

/**
 * Single-writer SQLite transactions keep cargo consumption, shared scores and
 * discoveries together.
 *
 * Opening the database parses and validates every saved sector once so the
 * write path can refuse duplicate asteroids across sectors. The store itself
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

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sectors (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pilots (id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
      // Persist the retired kit name once at startup, before validating saved flights.
      this.db.exec(`UPDATE pilots SET json = json_set(json, '$.kitId', 'scout')
        WHERE json_extract(json, '$.kitId') = 'surveyor'`);
      this.openedSectors = this.indexPersistedSectors();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private validateSectorValue(id: string, value: unknown): AsteroidData[] {
    if (!validSectorId(id) || !Array.isArray(value)) {
      throw new Error(`Saved sector ${id} is invalid; refusing to regenerate mined deposits`);
    }
    const ids = new Set<string>();
    const rocks: AsteroidData[] = [];
    for (const [index, saved] of value.entries()) {
      // Retired finite burns never stored an owner. Preserve the deposit and
      // momentum, but cancel that uncreditable propulsion at the storage boundary.
      let candidate = saved;
      if (typeof saved === 'object' && saved !== null && 'boost' in saved) {
        const boost = saved.boost;
        if (
          typeof boost === 'object' &&
          boost !== null &&
          'phase' in boost &&
          boost.phase === 'burning' &&
          !('ownerId' in boost) &&
          'remainingFrames' in boost &&
          typeof boost.remainingFrames === 'number' &&
          Number.isInteger(boost.remainingFrames) &&
          boost.remainingFrames > 0 &&
          boost.remainingFrames <= 180 &&
          'angle' in boost &&
          typeof boost.angle === 'number' &&
          Number.isFinite(boost.angle)
        ) {
          candidate = { ...saved, boost: null };
        }
      }
      try {
        validateAsteroidDto(candidate);
      } catch (error) {
        throw new Error(`Saved sector ${id} asteroid ${index} is invalid`, { cause: error });
      }
      if (
        candidate.id.length === 0 ||
        ids.has(candidate.id) ||
        !validWorldPosition(candidate.position) ||
        sectorAt(candidate.position).id !== id
      ) {
        throw new Error(`Saved sector ${id} contains an invalid or duplicate asteroid identity`);
      }
      ids.add(candidate.id);
      rocks.push(candidate);
    }
    return rocks;
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
        throw new Error(`Saved sector ${id} is not valid JSON`, { cause: error });
      }
      const rocks = this.validateSectorValue(id, value);
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
    const value: unknown = JSON.parse(this.worldJson);
    if (
      !value ||
      typeof value !== 'object' ||
      !('seed' in value) ||
      !('startedAt' in value) ||
      !('exploration' in value) ||
      typeof value.seed !== 'number' ||
      !Number.isFinite(value.seed) ||
      typeof value.startedAt !== 'number' ||
      !Number.isFinite(value.startedAt) ||
      !validExploration(value.exploration)
    ) {
      throw new Error('Saved world is invalid; refusing to replace player progress');
    }
    return {
      seed: value.seed,
      civicModules: readCivicModules(value),
      startedAt: value.startedAt,
      generation:
        'generation' in value &&
        typeof value.generation === 'number' &&
        Number.isSafeInteger(value.generation)
          ? value.generation
          : 0,
      ...('asteroidDensityVersion' in value &&
      typeof value.asteroidDensityVersion === 'number' &&
      Number.isSafeInteger(value.asteroidDensityVersion) &&
      value.asteroidDensityVersion >= 0
        ? { asteroidDensityVersion: value.asteroidDensityVersion }
        : {}),
      ...('asteroidMotionVersion' in value &&
      typeof value.asteroidMotionVersion === 'number' &&
      Number.isSafeInteger(value.asteroidMotionVersion) &&
      value.asteroidMotionVersion >= 0
        ? { asteroidMotionVersion: value.asteroidMotionVersion }
        : {}),
      ...releaseField(
        'writtenReleaseId',
        'writtenReleaseId' in value ? value.writtenReleaseId : undefined
      ),
      exploration: value.exploration,
    };
  }

  loadPilots(): PersistentPilot[] {
    return this.db
      .prepare('SELECT json FROM pilots')
      .all()
      .map((row) => {
        const value: unknown = JSON.parse(String(row['json']));
        const pilot = readPilot(value);
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
    return { world: this.loadWorld(), pilots: this.loadPilots(), sectors: this.loadSectors() };
  }

  /** One saved row, for tests and tooling; the server reads the world once through `load`. */
  loadSector(id: string): AsteroidData[] | undefined {
    if (!validSectorId(id)) {
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
    return this.validateSectorValue(id, value);
  }

  /**
   * Commit one batch of changed rows. `world` is omitted when the world row
   * did not change; unchanged pilot rows are skipped by content.
   */
  checkpoint(
    world: SavedWorld | undefined,
    sectors: ReadonlyMap<string, AsteroidData[]>,
    pilots: readonly PersistentPilot[]
  ): void {
    const validatedSectors = [...sectors].map(([id, rocks]): [string, AsteroidData[]] => [
      id,
      this.validateSectorValue(id, rocks),
    ]);
    this.assertNoDuplicateDeposits(validatedSectors);
    const worldJson = world === undefined ? undefined : JSON.stringify(world);
    const changedPilots = pilots
      .map((pilot) => ({ id: pilot.id, json: JSON.stringify(pilot) }))
      .filter((pilot) => this.pilotJson.get(pilot.id) !== pilot.json);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (worldJson !== undefined && this.worldJson !== worldJson) {
        this.db.prepare('INSERT OR REPLACE INTO world(id,json) VALUES(1,?)').run(worldJson);
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
      this.db.exec('DELETE FROM sectors; DELETE FROM pilots; DELETE FROM world;');
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
