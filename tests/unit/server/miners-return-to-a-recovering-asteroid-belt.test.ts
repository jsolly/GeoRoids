/* @vitest-environment node */
import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { ServerClock } from '../../../server/core/ServerClock';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import {
  ASTEROID_BELT,
  beltAsteroid,
  beltSlotForAsteroid,
  beltSlots,
} from '../../../shared/asteroidBelt';
import { sectorAt, WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

const SEED = 82;
const HOME = beltAsteroid(SEED, 60, 0);
const START = 1_000_000;

function expedition() {
  const field = new RegionalAsteroidField(SEED);
  const manager = new AsteroidManager(new RNGService(SEED));
  field.update(manager, [HOME.position], START);
  return { field, manager };
}

test('pilots find deterministic rich rows with two open crossing lanes', () => {
  const { field, manager } = expedition();
  const rocks = manager
    .getAllAsteroids()
    .filter((rock) => beltSlotForAsteroid(rock.id) !== undefined);
  expect(rocks.length).toBeGreaterThan(30);
  for (const rock of rocks) {
    expect(rock.material).toBe('metal');
    expect(rock.size).toBeGreaterThanOrEqual(72);
    expect(rock.velocity).toEqual({ x: 0, y: 0 });
  }
  expect(beltSlots()).not.toContain(9 * ASTEROID_BELT.rows);
  expect(beltSlots()).not.toContain(30 * ASTEROID_BELT.rows);
  const mirror = expedition();
  expect(mirror.field.beltState()).toEqual(field.beltState());
  expect(mirror.manager.getAsteroid(HOME.id)).toEqual(manager.getAsteroid(HOME.id));
});

test('a mined slot warns and recovers after five minutes while miners remain nearby', () => {
  const { field, manager } = expedition();
  manager.removeAsteroid(HOME.id);
  field.update(manager, [HOME.position], START);
  expect(field.recoveryWarnings(START)).toEqual([]);
  field.update(
    manager,
    [HOME.position],
    START + ASTEROID_BELT.recoveryMs - ASTEROID_BELT.warningMs
  );
  expect(
    field.recoveryWarnings(START + ASTEROID_BELT.recoveryMs - ASTEROID_BELT.warningMs)
  ).toEqual([
    {
      slot: 60,
      position: HOME.position,
      size: HOME.size,
      recoverAt: START + ASTEROID_BELT.recoveryMs,
    },
  ]);
  expect(manager.getAsteroid(beltAsteroid(SEED, 60, 1).id)).toBeUndefined();
  field.update(manager, [HOME.position], START + ASTEROID_BELT.recoveryMs);
  expect(manager.getAsteroid(beltAsteroid(SEED, 60, 1).id)).toEqual(beltAsteroid(SEED, 60, 1));
  expect(field.recoveryWarnings(START + ASTEROID_BELT.recoveryMs)).toEqual([]);
});

test('towing away a damaged deposit preserves the cargo while its home replenishes', () => {
  const { field, manager } = expedition();
  const cargo = manager.getAsteroid(HOME.id);
  expect(cargo).toBeDefined();
  if (!cargo) {
    throw new Error('Missing test cargo');
  }
  cargo.health = 17;
  cargo.position = { x: HOME.position.x - 1000, y: HOME.position.y };
  field.update(manager, [HOME.position, cargo.position], START);
  field.update(manager, [HOME.position, cargo.position], START + ASTEROID_BELT.recoveryMs);
  expect(manager.getAsteroid(HOME.id)?.health).toBe(17);
  expect(manager.getAsteroid(HOME.id)?.position).toEqual(cargo.position);
  expect(manager.getAsteroid(beltAsteroid(SEED, 60, 1).id)?.health).toBe(150);
});

test('recovery survives SQLite restart and expires while the home sector sleeps', () => {
  const { field, manager } = expedition();
  manager.removeAsteroid(HOME.id);
  field.update(manager, [HOME.position], START);
  field.update(manager, [{ x: -10_000, y: 0 }], START + 1);
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: SEED,
        startedAt: START,
        generation: WORLD.generation,
        exploration: [],
        asteroidBelt: [...field.beltState()],
      },
      field.checkpoint(manager),
      []
    );
    const restored = new RegionalAsteroidField(
      SEED,
      store.loadSectors(),
      store.loadWorld()?.asteroidBelt
    );
    const freshManager = new AsteroidManager(new RNGService(SEED));
    restored.update(freshManager, [{ x: -10_000, y: 0 }], START + ASTEROID_BELT.recoveryMs);
    expect(restored.dormantAsteroid(beltAsteroid(SEED, 60, 1).id, HOME.position)).toBeDefined();
    restored.update(freshManager, [HOME.position], START + ASTEROID_BELT.recoveryMs + 1);
    expect(freshManager.getAsteroid(HOME.id)).toBeUndefined();
    expect(freshManager.getAsteroid(beltAsteroid(SEED, 60, 1).id)).toBeDefined();
  } finally {
    store.close();
  }
});

test('existing mined sectors gain the new belt without restoring ordinary harvested deposits', () => {
  const sector = sectorAt(HOME.position).id;
  const field = new RegionalAsteroidField(SEED, new Map([[sector, []]]));
  const rows = field.dormantSectors().get(sector) ?? [];
  expect(rows.some((rock) => rock.id === HOME.id)).toBe(true);
  expect(rows.every((rock) => beltSlotForAsteroid(rock.id) !== undefined)).toBe(true);
});

test('a short tow across a sector edge does not duplicate the host after sleep and restart', () => {
  const { field, manager } = expedition();
  const home = beltAsteroid(SEED, 57, 0);
  const host = manager.getAsteroid(home.id);
  if (!host) {
    throw new Error('Missing edge deposit');
  }
  host.position = { x: home.position.x, y: -home.position.y };
  expect(sectorAt(host.position).id).not.toBe(sectorAt(home.position).id);
  expect(
    Math.hypot(host.position.x - home.position.x, host.position.y - home.position.y)
  ).toBeLessThan(ASTEROID_BELT.removalDistance);
  field.update(manager, [home.position], START);
  field.update(manager, [{ x: -10_000, y: 0 }], START + 1);
  expect(field.beltState().find((entry) => entry.slot === 57)?.recoverAt).toBeNull();
  const restored = new RegionalAsteroidField(SEED, field.checkpoint(manager), field.beltState());
  const freshManager = new AsteroidManager(new RNGService(SEED));
  restored.update(freshManager, [{ x: -10_000, y: 0 }], START + ASTEROID_BELT.recoveryMs + 2);
  expect(restored.beltState().find((entry) => entry.slot === 57)).toEqual({
    slot: 57,
    generation: 0,
    recoverAt: null,
  });
  restored.update(freshManager, [home.position], START + ASTEROID_BELT.recoveryMs + 3);
  expect(freshManager.getAsteroid(home.id)?.position).toEqual(host.position);
  expect(freshManager.getAsteroid(beltAsteroid(SEED, 57, 1).id)).toBeUndefined();
});

test('the last miner leaving immediately after mining preserves the offline recovery deadline', () => {
  let now = START;
  const clock = () => new ServerClock({ wallNow: () => now, monotonicNow: () => 0 });
  const store = new WorldStore(':memory:');
  let first: GameEngine | undefined;
  let second: GameEngine | undefined;
  try {
    first = new GameEngine(SEED, clock(), new InlineWorldPersistence(store));
    const pilot = first.addPlayer('miner', 'Miner', new RecordingSocket(), HOME.position);
    pilot.position = { ...HOME.position };
    first.ensureAsteroidField();
    expect(first.getAsteroid(HOME.id)).toBeDefined();
    first.removeAsteroid(HOME.id);
    first.removePlayer(pilot.id);
    expect(store.loadWorld()?.asteroidBelt?.find((entry) => entry.slot === 60)?.recoverAt).toBe(
      START + ASTEROID_BELT.recoveryMs
    );
    now = START + ASTEROID_BELT.recoveryMs + 1;
    second = new GameEngine(SEED, clock(), new InlineWorldPersistence(store));
    const returning = second.addPlayer(
      'returning',
      'Returning',
      new RecordingSocket(),
      HOME.position
    );
    returning.position = { ...HOME.position };
    second.ensureAsteroidField();
    expect(second.getAsteroid(beltAsteroid(SEED, 60, 1).id)).toBeDefined();
  } finally {
    first?.stopGameLoop();
    second?.stopGameLoop();
    store.close();
  }
});
