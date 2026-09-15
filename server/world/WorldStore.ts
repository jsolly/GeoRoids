import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validExploration } from '../../shared/exploration';
import { finiteMotionVector } from '../../shared/playerMotion';
import { readCompletedSectorIds } from '../../shared/sectors';
import { validateAsteroidDto } from '../../shared/snapshotDto';
import { isScoreSeason, parseSectorId, sectorAt, WORLD } from '../../shared/world';
import type { AsteroidData, ExplorationTile, Position } from '../../shared-types';

function validSectorId(id: string): boolean {
  return parseSectorId(id) !== null;
}

function validWorldPosition(position: Position): boolean {
  return finiteMotionVector(position) && Math.hypot(position.x, position.y) <= WORLD.radius;
}

/** Browser credential plus this UTC month's score. Placement is never stored. */
export interface PersistentPilot {
  id: string;
  tokenHash: string;
  name: string;
  score: number;
}

interface SavedWorld {
  seed: number;
  startedAt: number;
  generation: number;
  scoreSeason?: string;
  exploration: ExplorationTile[];
  completedSectors: string[];
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
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof tokenHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(tokenHash) ||
    typeof score !== 'number' ||
    !Number.isFinite(score)
  ) {
    return undefined;
  }
  return { id, tokenHash, name, score };
}

/** Single-writer SQLite transactions keep cargo consumption, shared scores and discoveries together. */
export class WorldStore {
  private readonly db: DatabaseSync;
  private readonly pilotJson = new Map<string, string>();
  private persistedAsteroidSectors = new Map<string, string>();
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
      this.indexPersistedSectors();
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
    for (const [index, candidate] of value.entries()) {
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

  private indexSector(
    index: Map<string, string>,
    id: string,
    rocks: readonly AsteroidData[]
  ): void {
    for (const rock of rocks) {
      const previousSector = index.get(rock.id);
      if (previousSector !== undefined && previousSector !== id) {
        throw new Error(`Saved asteroid ${rock.id} appears in sectors ${previousSector} and ${id}`);
      }
      index.set(rock.id, id);
    }
  }

  private indexPersistedSectors(): void {
    const next = new Map<string, string>();
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
      this.indexSector(next, id, rocks);
    }
    this.persistedAsteroidSectors = next;
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
      startedAt: value.startedAt,
      generation:
        'generation' in value &&
        typeof value.generation === 'number' &&
        Number.isSafeInteger(value.generation)
          ? value.generation
          : 0,
      ...('scoreSeason' in value && isScoreSeason(value.scoreSeason)
        ? { scoreSeason: value.scoreSeason }
        : {}),
      exploration: value.exploration,
      completedSectors:
        'completedSectors' in value ? readCompletedSectorIds(value.completedSectors) : [],
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

  listSectorIds(): string[] {
    return this.db
      .prepare('SELECT id FROM sectors')
      .all()
      .map((row) => {
        const id = row['id'];
        if (typeof id !== 'string' || !validSectorId(id)) {
          throw new Error('Saved sector has an invalid identity');
        }
        return id;
      });
  }

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

  checkpoint(
    world: SavedWorld,
    sectors: ReadonlyMap<string, AsteroidData[]>,
    pilots: readonly PersistentPilot[]
  ): void {
    const sectorEntries = [...sectors.entries()];
    const validatedSectors = sectorEntries.map(([id, rocks]): [string, AsteroidData[]] => [
      id,
      this.validateSectorValue(id, rocks),
    ]);
    const nextAsteroidSectors = new Map(this.persistedAsteroidSectors);
    const updatedSectorIds = new Set(validatedSectors.map(([id]) => id));
    for (const [asteroidId, sectorId] of nextAsteroidSectors) {
      if (updatedSectorIds.has(sectorId)) {
        nextAsteroidSectors.delete(asteroidId);
      }
    }
    for (const [id, rocks] of validatedSectors) {
      this.indexSector(nextAsteroidSectors, id, rocks);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const worldJson = JSON.stringify(world);
      if (this.worldJson !== worldJson) {
        this.db.prepare('INSERT OR REPLACE INTO world(id,json) VALUES(1,?)').run(worldJson);
      }
      const sectorWrite = this.db.prepare('INSERT OR REPLACE INTO sectors(id,json) VALUES(?,?)');
      for (const [id, rocks] of validatedSectors) {
        sectorWrite.run(id, JSON.stringify(rocks));
      }
      const pilotWrite = this.db.prepare('INSERT OR REPLACE INTO pilots(id,json) VALUES(?,?)');
      const changedPilots = pilots
        .map((pilot) => ({ id: pilot.id, json: JSON.stringify(pilot) }))
        .filter((pilot) => this.pilotJson.get(pilot.id) !== pilot.json);
      for (const pilot of changedPilots) {
        pilotWrite.run(pilot.id, pilot.json);
      }
      this.db.exec('COMMIT');
      this.worldJson = worldJson;
      this.persistedAsteroidSectors = nextAsteroidSectors;
      for (const pilot of changedPilots) {
        this.pilotJson.set(pilot.id, pilot.json);
      }
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reset(): void {
    this.db.exec(
      'BEGIN IMMEDIATE; DELETE FROM sectors; DELETE FROM pilots; DELETE FROM world; COMMIT;'
    );
    this.persistedAsteroidSectors.clear();
    this.pilotJson.clear();
    this.worldJson = undefined;
  }

  close(): void {
    this.db.close();
  }
}
