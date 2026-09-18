/* @vitest-environment node */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
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
  const field = new RegionalAsteroidField(SEED, store);
  const manager = new AsteroidManager(new RNGService(SEED));
  const completed = new Set<string>();
  let x = 9_000;
  let y = 9_000;
  while (field.visitedSectorIds().length < SAVED_SECTORS) {
    field.update(manager, [{ x, y }], completed);
    x += WORLD.sectorSize * 3;
    if (x > 40_000) {
      x = 9_000;
      y += WORLD.sectorSize * 3;
    }
  }
  field.update(manager, [{ x: 0, y: 0 }], completed);
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
      completedSectors: [],
    },
    rows,
    []
  );
  field.saved();
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

test('an explored world with hundreds of saved sectors keeps each simulation frame off the database', () => {
  const store = new WorldStore(':memory:');
  cleanups.push(() => store.close());
  const harvested = '4,4';
  const untouched = '5,4';
  exploreAndSave(
    store,
    new Map([
      [harvested, []],
      [untouched, [deposit('remaining-ore', { x: 11_000, y: 9_000 })]],
    ])
  );
  expect(store.loadSector(harvested)).toEqual([]);
  expect(store.loadSector(untouched)).toHaveLength(1);

  let elapsed = 0;
  const clock = new ServerClock({ wallNow: () => WALL_ORIGIN_MS, monotonicNow: () => elapsed });
  const engine = new GameEngine(SEED, clock, store);
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

  // Sector completion still sees every saved sector: the harvested one walls
  // off once mapped, the one with a deposit left does not.
  engine.revealArea({ x: 9_000, y: 9_000 }, WORLD.sectorSize);
  engine.revealArea({ x: 11_000, y: 9_000 }, WORLD.sectorSize);
  const completed = engine.evaluateSectorProgress();
  expect(completed).toContain(harvested);
  expect(completed).not.toContain(untouched);
  expect(engine.getCompletedSectors()).toContain(harvested);
});
