/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { ASTEROID_INTERACTIONS } from '../../../shared/asteroidPhenomena';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

function legacyRock(seed: number, slot: number, position = { x: 200, y: 200 }): AsteroidData {
  return {
    id: `deposit-${seed}-0-0-${slot}`,
    position: { ...position, x: position.x + slot },
    velocity: { x: 1, y: 0 },
    size: 25,
    jaggedness: 0.2,
    rotation: 0,
    angularVelocity: 0,
    health: 25,
    maxHealth: 25,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

const ROID_SPEED_FLOOR = 0.1;

test('a fresh sector creates 72 deterministic slots with mostly drifting rocks at varied speeds', () => {
  const field = new RegionalAsteroidField(82);
  const manager = new AsteroidManager(new RNGService(82));
  const mirrorField = new RegionalAsteroidField(82);
  const mirrorManager = new AsteroidManager(new RNGService(82));

  field.update(manager, [{ x: 0, y: 0 }]);
  mirrorField.update(mirrorManager, [{ x: 0, y: 0 }]);
  const sectorPrefix = 'deposit-82-0-0-';
  const rocks = manager.getAllAsteroids().filter((rock) => rock.id.startsWith(sectorPrefix));
  const mirrorRocks = mirrorManager
    .getAllAsteroids()
    .filter((rock) => rock.id.startsWith(sectorPrefix));

  expect(rocks).toHaveLength(WORLD.depositsPerSector);
  expect(
    rocks.map((rock) => ({ id: rock.id, position: rock.position, velocity: rock.velocity }))
  ).toEqual(
    mirrorRocks.map((rock) => ({ id: rock.id, position: rock.position, velocity: rock.velocity }))
  );
  expect(rocks.filter((rock) => rock.velocity.x === 0 && rock.velocity.y === 0)).toHaveLength(
    Math.round(WORLD.depositsPerSector * ROID.STATIONARY_FRACTION)
  );
  expect(rocks.filter((rock) => rock.velocity.x !== 0 || rock.velocity.y !== 0)).toHaveLength(
    WORLD.depositsPerSector - Math.round(WORLD.depositsPerSector * ROID.STATIONARY_FRACTION)
  );
  expect(
    rocks.some((rock) => Math.hypot(rock.velocity.x, rock.velocity.y) > ROID_SPEED_FLOOR)
  ).toBe(true);
  const speeds = rocks
    .map((rock) => Math.hypot(rock.velocity.x, rock.velocity.y))
    .filter((speed) => speed > 0);
  expect(Math.min(...speeds)).toBeGreaterThanOrEqual(ROID.DRIFT_SPEED_MIN - 1e-9);
  expect(Math.max(...speeds)).toBeLessThanOrEqual(ROID.DRIFT_SPEED_MAX + 1e-9);
  expect(speeds.some((speed) => speed < ROID.DRIFT_SPEED_MAX / 3)).toBe(true);
  expect(speeds.some((speed) => speed > ROID.DRIFT_SPEED_MAX * 0.8)).toBe(true);
  expect(rocks.some((rock) => rock.size >= ROID.COLOSSAL_MIN_SIZE)).toBe(false);
  expect(rocks.filter((rock) => rock.phenomenon?.kind === 'reflective')).toHaveLength(6);
  expect(new Set(rocks.map((rock) => rock.id)).size).toBe(rocks.length);
});

test('saved legacy sectors add only missing slots and preserve harvested and moved IDs', () => {
  const seed = 82;
  const harvestedLegacyId = `deposit-${seed}-0-0-5`;
  const movedNewId = `deposit-${seed}-0-0-${WORLD.legacyDepositsPerSector}`;
  const savedLegacy = Array.from({ length: WORLD.legacyDepositsPerSector }, (_, slot) =>
    legacyRock(seed, slot)
  ).filter((rock) => rock.id !== harvestedLegacyId);
  const movedNew = legacyRock(seed, 99, { x: WORLD.sectorSize + 200, y: 200 });
  movedNew.id = movedNewId;
  const field = new RegionalAsteroidField(
    seed,
    new Map([
      ['0,0', savedLegacy],
      ['1,0', [movedNew]],
    ])
  );

  const migrated = field.migrateSavedSectors();
  const source = migrated.get('0,0');
  expect(source).toBeDefined();
  expect(source).toHaveLength(WORLD.depositsPerSector - 2);
  expect(source?.some((rock) => rock.id === harvestedLegacyId)).toBe(false);
  expect(source?.some((rock) => rock.id === movedNewId)).toBe(false);
  expect(source?.filter((rock) => rock.id.startsWith(`deposit-${seed}-0-0-`))).toHaveLength(
    WORLD.depositsPerSector - 2
  );
  const neighbor = field.dormantSectors().get('1,0');
  const addedNeighborSlots = WORLD.depositsPerSector - WORLD.legacyDepositsPerSector;
  expect(neighbor?.some((rock) => rock.id === movedNew.id)).toBe(true);
  expect(neighbor?.filter((rock) => rock.id.startsWith(`deposit-${seed}-1-0-`))).toHaveLength(
    addedNeighborSlots
  );
  expect(neighbor).toHaveLength(addedNeighborSlots + 1);
  expect(field.migrateSavedSectors()).toEqual(new Map());
});

test('empty saved sectors stay empty during the density migration', () => {
  const seed = 82;
  const field = new RegionalAsteroidField(seed, new Map([['0,0', []]]));

  expect(field.migrateSavedSectors()).toEqual(new Map());
  expect(field.dormantSectors().get('0,0')).toEqual([]);
});

test('the density marker keeps a destroyed added slot absent after a reload', () => {
  const store = new WorldStore(':memory:');
  let first: GameEngine | undefined;
  let second: GameEngine | undefined;
  try {
    const seed = 82;
    const savedAt = Date.now();
    store.checkpoint(
      {
        seed,
        startedAt: savedAt,
        generation: WORLD.generation,
        scoreSeason: utcScoreSeason(savedAt),
        exploration: [],
      },
      new Map([
        [
          '0,0',
          Array.from({ length: WORLD.legacyDepositsPerSector }, (_, slot) =>
            legacyRock(seed, slot)
          ),
        ],
      ]),
      []
    );

    first = new GameEngine(seed, undefined, new InlineWorldPersistence(store));
    const pilot = first.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 200, y: 200 });
    first.ensureAsteroidField();
    const addedId = `deposit-${seed}-0-0-${WORLD.legacyDepositsPerSector}`;
    expect(first.getAsteroid(addedId)).toBeDefined();
    first.removeAsteroid(addedId);
    first.checkpointWorld();
    expect(store.loadWorld()?.asteroidDensityVersion).toBe(WORLD.asteroidDensityVersion);
    expect(store.loadSector('0,0')?.some((rock) => rock.id === addedId)).toBe(false);
    first.removePlayer(pilot.id);

    second = new GameEngine(seed, undefined, new InlineWorldPersistence(store));
    second.addPlayer('pilot-2', 'Pilot 2', new RecordingSocket(), { x: 200, y: 200 });
    second.ensureAsteroidField();
    expect(second.getAsteroid(addedId)).toBeUndefined();
  } finally {
    first?.stopGameLoop();
    second?.stopGameLoop();
    store.close();
  }
});

test('saved stationary deposits wake once without restoring mined ore or resetting flight on reload', () => {
  const store = new WorldStore(':memory:');
  const seed = 82;
  const now = Date.now();
  const rows = Array.from({ length: WORLD.depositsPerSector }, (_, slot) => ({
    ...legacyRock(seed, slot),
    velocity: { x: 0, y: 0 },
  }));
  const harvested = rows.splice(20, 1)[0];
  const moved = rows.find((rock) => rock.id.endsWith('-21'));
  const armed = rows.find((rock) => rock.id.endsWith('-22'));
  assert.ok(harvested && moved && armed);
  moved.velocity = { x: 0.42, y: -0.17 };
  armed.boost = { phase: 'armed', ownerId: 'pilot', angle: 0 };
  let first: GameEngine | undefined;
  let second: GameEngine | undefined;
  try {
    store.checkpoint(
      {
        seed,
        startedAt: now,
        generation: WORLD.generation,
        scoreSeason: utcScoreSeason(now),
        asteroidDensityVersion: WORLD.asteroidDensityVersion,
        exploration: [],
      },
      new Map([
        ['0,0', rows],
        ['1,0', [legacyRock(seed, 99, { x: 2200, y: 200 })]],
        ['2,0', []],
      ]),
      []
    );
    first = new GameEngine(seed, undefined, new InlineWorldPersistence(store));
    first.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 200, y: 200 });
    first.ensureAsteroidField();
    const awakened = first.getAsteroid(`deposit-${seed}-0-0-23`);
    assert.ok(awakened);
    expect(Math.hypot(awakened.velocity.x, awakened.velocity.y)).toBeGreaterThan(0);
    expect(awakened.position).toEqual(rows.find((rock) => rock.id === awakened.id)?.position);
    expect(first.getAsteroid(harvested.id)).toBeUndefined();
    expect(first.getAsteroid(moved.id)?.velocity).toEqual(moved.velocity);
    expect(first.getAsteroid(armed.id)?.boost).toEqual(armed.boost);
    expect(first.getAsteroid(armed.id)?.velocity).toEqual({ x: 0, y: 0 });
    awakened.velocity = { x: 0, y: 0 };
    first.checkpointWorld();
    expect(store.loadWorld()?.asteroidMotionVersion).toBe(WORLD.asteroidMotionVersion);
    second = new GameEngine(seed, undefined, new InlineWorldPersistence(store));
    second.addPlayer('pilot2', 'Pilot2', new RecordingSocket(), { x: 200, y: 200 });
    second.ensureAsteroidField();
    expect(second.getAsteroid(awakened.id)?.velocity).toEqual({ x: 0, y: 0 });
    expect(second.getAsteroid(harvested.id)).toBeUndefined();
    expect(store.loadSector('2,0')).toEqual([]);
  } finally {
    first?.stopGameLoop();
    second?.stopGameLoop();
    store.close();
  }
});

test('saved intact reflectors become pinball pockets without healing rocks or restoring a missing member', () => {
  const cluster = [1, 2, 3].map((slot) => ({
    ...legacyRock(82, slot, { x: 1900, y: 1700 + slot * 10 }),
    velocity: { x: 0, y: 0 },
    health: 40,
    phenomenon: { kind: 'reflective' as const, clusterId: 'intact', energy: 2, maxEnergy: 6 },
  }));
  const partial = [4, 5].map((slot) => ({
    ...legacyRock(82, slot),
    velocity: { x: 0, y: 0 },
    phenomenon: { kind: 'reflective' as const, clusterId: 'partial', energy: 1, maxEnergy: 6 },
  }));
  const field = new RegionalAsteroidField(82, new Map([['0,0', [...cluster, ...partial]]]));
  field.migrateSavedMotion();
  const rows = field.dormantSectors().get('0,0');
  assert.ok(rows);
  expect(rows).toHaveLength(5);
  const pocket = rows.filter(
    (rock) => rock.phenomenon?.kind === 'reflective' && rock.phenomenon.clusterId === 'intact'
  );
  expect(
    pocket.every(
      (rock) =>
        rock.health === 40 && rock.phenomenon?.kind === 'reflective' && rock.phenomenon.energy === 2
    )
  ).toBe(true);
  const center = {
    x: pocket.reduce((sum, rock) => sum + rock.position.x, 0) / 3,
    y: pocket.reduce((sum, rock) => sum + rock.position.y, 0) / 3,
  };
  for (const rock of pocket) {
    expect(Math.hypot(rock.position.x - center.x, rock.position.y - center.y)).toBeCloseTo(
      ASTEROID_INTERACTIONS.clusterRadius
    );
    expect(rock.position.x + ASTEROID_INTERACTIONS.reflectiveSize).toBeLessThan(WORLD.sectorSize);
  }
  expect(
    rows.filter(
      (rock) => rock.phenomenon?.kind === 'reflective' && rock.phenomenon.clusterId === 'partial'
    )
  ).toEqual(partial);
  const once = structuredClone(rows);
  field.migrateSavedMotion();
  expect(field.dormantSectors().get('0,0')).toEqual(once);
});
