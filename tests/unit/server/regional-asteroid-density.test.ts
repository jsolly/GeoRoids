/* @vitest-environment node */
import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function completeNeighbors(): Set<string> {
  const completed = new Set<string>();
  for (let y = -2; y <= 1; y++) {
    for (let x = -2; x <= 1; x++) {
      if (x !== 0 || y !== 0) {
        completed.add(`${x},${y}`);
      }
    }
  }
  return completed;
}

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

test('a fresh sector creates 72 deterministic slots with an even stationary and moving mix', () => {
  const field = new RegionalAsteroidField(82);
  const manager = new AsteroidManager(new RNGService(82));
  const mirrorField = new RegionalAsteroidField(82);
  const mirrorManager = new AsteroidManager(new RNGService(82));

  field.update(manager, [{ x: 0, y: 0 }], completeNeighbors());
  mirrorField.update(mirrorManager, [{ x: 0, y: 0 }], completeNeighbors());
  const rocks = manager.getAllAsteroids();
  const mirrorRocks = mirrorManager.getAllAsteroids();

  expect(rocks).toHaveLength(WORLD.depositsPerSector);
  expect(
    rocks.map((rock) => ({ id: rock.id, position: rock.position, velocity: rock.velocity }))
  ).toEqual(
    mirrorRocks.map((rock) => ({ id: rock.id, position: rock.position, velocity: rock.velocity }))
  );
  expect(rocks.filter((rock) => rock.velocity.x === 0 && rock.velocity.y === 0)).toHaveLength(
    WORLD.depositsPerSector / 2
  );
  expect(rocks.filter((rock) => rock.velocity.x !== 0 || rock.velocity.y !== 0)).toHaveLength(
    WORLD.depositsPerSector / 2
  );
  expect(
    rocks.some((rock) => Math.hypot(rock.velocity.x, rock.velocity.y) > ROID_SPEED_FLOOR)
  ).toBe(true);
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

  const migrated = field.migrateSavedSectors(new Set(['1,0']));
  const source = migrated.get('0,0');
  expect(source).toBeDefined();
  expect(source).toHaveLength(WORLD.depositsPerSector - 2);
  expect(source?.some((rock) => rock.id === harvestedLegacyId)).toBe(false);
  expect(source?.some((rock) => rock.id === movedNewId)).toBe(false);
  expect(source?.filter((rock) => rock.id.startsWith(`deposit-${seed}-0-0-`))).toHaveLength(
    WORLD.depositsPerSector - 2
  );
  expect(field.dormantSectors().get('1,0')).toEqual([movedNew]);
  expect(field.migrateSavedSectors(new Set(['1,0']))).toEqual(new Map());
});

test('empty saved sectors stay empty during the density migration', () => {
  const seed = 82;
  const field = new RegionalAsteroidField(seed, new Map([['0,0', []]]));

  expect(field.migrateSavedSectors(new Set())).toEqual(new Map());
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
        completedSectors: [],
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
