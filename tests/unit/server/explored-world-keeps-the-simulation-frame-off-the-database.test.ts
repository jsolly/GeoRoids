/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

const SEED = 731;
const WALL_ORIGIN_MS = 10_000;
const SAVED_SECTORS = 300;

function deposit(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

/**
 * Persist an explored world the way real flight does: a pilot activates
 * sectors, flies on, and the field puts the ones left behind to sleep.
 */
function exploreAndSave(store: WorldStore, extra: ReadonlyMap<string, AsteroidData[]>): void {
  const field = new RegionalAsteroidField(SEED, store.loadSectors());
  const manager = new AsteroidManager(new RNGService(SEED));
  let x = 9_000;
  let y = 9_000;
  while (field.visitedSectorIds().length < SAVED_SECTORS) {
    field.update(manager, [{ x, y }]);
    x += WORLD.sectorSize * 3;
    if (x > 40_000) {
      x = 9_000;
      y += WORLD.sectorSize * 3;
    }
  }
  field.update(manager, [{ x: 0, y: 0 }]);
  const rows = new Map(field.checkpoint(manager));
  for (const [id, rocks] of extra) {
    rows.set(id, rocks);
  }
  store.checkpoint(
    {
      seed: SEED,
      startedAt: WALL_ORIGIN_MS,
      generation: WORLD.generation,
      scoreSeason: utcScoreSeason(WALL_ORIGIN_MS),
      exploration: [],
    },
    rows,
    []
  );
  field.saved();
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

test('an explored world with hundreds of saved sectors keeps each simulation frame off the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-explored-world-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'world.sqlite');
  const harvested = '3,4';
  const untouched = '5,4';
  {
    const saving = new WorldStore(path);
    exploreAndSave(
      saving,
      new Map([
        [harvested, []],
        [untouched, [deposit('remaining-ore', { x: 11_000, y: 9_000 })]],
      ])
    );
    saving.close();
  }
  // A restarted server opens the saved world cold, exactly as Railway does.
  const store = new WorldStore(path);
  cleanups.push(() => store.close());
  expect(store.loadSector(harvested)).toEqual([]);
  expect(store.loadSector(untouched)).toHaveLength(1);

  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => WALL_ORIGIN_MS, monotonicNow: () => elapsed });
  const engine = new GameEngine(SEED, clock, new InlineWorldPersistence(store));
  cleanups.push(() => engine.stopGameLoop());
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
  pilot.asteroidInteractions = 1;
  expect(engine.getDiagnostics().isPaused).toBe(false);

  // Steady flight: the pilot stays inside already-active sectors, so nothing
  // about the saved world needs to touch SQLite on these frames.
  const statements = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const scripts = vi.spyOn(DatabaseSync.prototype, 'exec');
  for (let frame = 0; frame < 3; frame++) {
    elapsed += 1000 / 60;
    engine.advanceOneFrame(clock.now());
  }
  expect(engine.getDiagnostics().gameTime).toBe(3);
  expect(statements).not.toHaveBeenCalled();
  expect(scripts).not.toHaveBeenCalled();

  // Mapping harvested ground does not wall it off, move the ship, or refill it.
  engine.revealArea({ x: 7_000, y: 9_000 }, WORLD.sectorSize);
  engine.revealArea({ x: 11_000, y: 9_000 }, WORLD.sectorSize);
  pilot.position = { x: 7_000, y: 9_000 };
  pilot.velocity = { x: 0, y: 0 };
  elapsed += 1000 / 60;
  engine.advanceOneFrame(clock.now());
  expect(pilot.position).toEqual({ x: 7_000, y: 9_000 });
  expect(pilot.health).toBeGreaterThan(0);
  expect(
    engine
      .getAllAsteroids()
      .some(
        (rock) =>
          rock.position.x >= 6_000 &&
          rock.position.x < 8_000 &&
          rock.position.y >= 8_000 &&
          rock.position.y < 10_000
      )
  ).toBe(false);
  expect(engine.getGameState()).not.toHaveProperty('completedSectors');
});
