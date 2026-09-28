/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { fieldRichness, sectorDeposits } from '../../../server/world/depositLayout';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { RegionalAsteroidField } from '../../../server/world/RegionalAsteroidField';
import { WorldStore } from '../../../server/world/WorldStore';
import { isInBeltFootprint } from '../../../shared/asteroidBelt';
import { sectorAt, WORLD } from '../../../shared/world';
import type { AsteroidData, Position } from '../../../shared-types';
import { DEPOSIT_FIELD, ROID } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const SEED = 82;
const INTERVAL = DEPOSIT_FIELD.REGROWTH_INTERVAL_MS;
/** Production passes epoch-scale server time; small clocks would hide restart bugs. */
const T0 = 1_790_000_000_000;

function isStationary(rock: AsteroidData): boolean {
  return rock.velocity.x === 0 && rock.velocity.y === 0;
}

function sectorSample(seed: number): AsteroidData[][] {
  const sectors: AsteroidData[][] = [];
  for (let y = -12; y <= 12; y += 3) {
    for (let x = -12; x <= 12; x += 3) {
      sectors.push(sectorDeposits(seed, x, y));
    }
  }
  return sectors;
}

function awakeField(observer: Position, now = T0) {
  const field = new RegionalAsteroidField(SEED);
  const manager = new AsteroidManager(new RNGService(SEED));
  field.update(manager, [observer], now);
  return { field, manager };
}

/** Ordinary home-sector slots of 0,0 at least this far from the observer. */
function hiddenSlots(manager: AsteroidManager, observer: Position): AsteroidData[] {
  return manager
    .getAllAsteroids()
    .filter(
      (rock) =>
        rock.id.startsWith(`deposit-${SEED}-0-0-`) &&
        !rock.phenomenon &&
        !rock.isCollabTarget &&
        Math.hypot(rock.position.x - observer.x, rock.position.y - observer.y) >
          DEPOSIT_FIELD.REGROWTH_HIDDEN_DISTANCE + 50
    );
}

function idCount(field: RegionalAsteroidField, manager: AsteroidManager, id: string): number {
  let count = manager.getAsteroid(id) ? 1 : 0;
  for (const rows of field.dormantSectors().values()) {
    count += rows.filter((rock) => rock.id === id).length;
  }
  return count;
}

test('the universe forms rich asteroid fields and quiet voids from one deterministic layout', () => {
  const sectors = sectorSample(SEED);
  expect(sectorSample(SEED)).toEqual(sectors);
  const counts = sectors.map((rocks) => rocks.length);
  const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;

  // The old even sprinkle held 72 per sector everywhere.
  expect(mean).toBeGreaterThan(90);
  expect(Math.max(...counts)).toBeGreaterThan(DEPOSIT_FIELD.PEAK_DEPOSITS * 0.6);
  expect(Math.min(...counts)).toBeLessThan(DEPOSIT_FIELD.VOID_DEPOSITS * 2);
  expect(Math.max(...counts)).toBeLessThanOrEqual(DEPOSIT_FIELD.PEAK_DEPOSITS);

  const ids = sectors.flat().map((rock) => rock.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const rocks of sectors) {
    for (const rock of rocks) {
      const sector = sectorAt(rock.position);
      expect(rock.id).toMatch(new RegExp(`^deposit-${SEED}-${sector.x}-${sector.y}-\\d+$`, 'u'));
    }
  }

  // Richness is continuous, so fields cross sector edges instead of stopping at them.
  const edge = WORLD.sectorSize * 3;
  expect(
    Math.abs(
      fieldRichness(SEED, { x: edge - 1, y: 900 }) - fieldRichness(SEED, { x: edge, y: 900 })
    )
  ).toBeLessThan(0.01);

  // Rich cores hold more stationary reef rocks than voids.
  const byRichness = [...sectors].sort((a, b) => a.length - b.length);
  const stillShare = (rocks: AsteroidData[]) =>
    rocks.filter(isStationary).length / Math.max(1, rocks.length);
  const quiet = byRichness.slice(0, 10).flat();
  const rich = byRichness.slice(-10).flat();
  expect(stillShare(rich)).toBeGreaterThan(stillShare(quiet));
});

test('a new pilot launches into a busy but survivable neighborhood', () => {
  const launchCap = Math.round(
    DEPOSIT_FIELD.VOID_DEPOSITS +
      (DEPOSIT_FIELD.PEAK_DEPOSITS - DEPOSIT_FIELD.VOID_DEPOSITS) * DEPOSIT_FIELD.LAUNCH_RICHNESS
  );
  for (const seed of [SEED, 42, 0x7ec01d]) {
    const launch = [-1, 0].flatMap((y) => [-1, 0].map((x) => sectorDeposits(seed, x, y)));
    const near = launch
      .flat()
      .filter(
        (rock) => Math.hypot(rock.position.x, rock.position.y) < DEPOSIT_FIELD.LAUNCH_CALM_INNER
      );
    // Never emptier than a void, never much denser than the launch cap allows
    // (bounded placement retries leak a little uniform spread).
    const calmArea = Math.PI * DEPOSIT_FIELD.LAUNCH_CALM_INNER ** 2;
    const sectorArea = WORLD.sectorSize ** 2;
    expect(near.length).toBeGreaterThan((DEPOSIT_FIELD.VOID_DEPOSITS * calmArea) / sectorArea / 2);
    expect(near.length).toBeLessThanOrEqual((1.2 * launchCap * calmArea) / sectorArea);
    for (const rock of near) {
      expect(Math.hypot(rock.position.x, rock.position.y)).toBeGreaterThanOrEqual(
        DEPOSIT_FIELD.LAUNCH_CLEARANCE - 1e-6
      );
      expect(Math.hypot(rock.velocity.x, rock.velocity.y)).toBeLessThan(ROID.FAST_DRIFT_SPEED_MIN);
    }
  }
});

test('the eastern belt keeps clear lanes inside the surrounding rich field', () => {
  for (const seed of [SEED, 42, 0x7ec01d]) {
    const around = [1, 2, 3].flatMap((x) =>
      [-3, -2, -1, 0, 1, 2].map((y) => sectorDeposits(seed, x, y))
    );
    const deposits = around.flat();
    expect(deposits.length).toBeGreaterThan(0);
    expect(deposits.filter((rock) => isInBeltFootprint(rock.position) && !rock.phenomenon)).toEqual(
      []
    );
  }
});

test('deposits vary in size, drift, spin and outline instead of repeating one rock', () => {
  const rocks = sectorSample(SEED)
    .flat()
    .filter(
      (rock) => !rock.phenomenon && !rock.isCollabTarget && rock.size < ROID.COLOSSAL_MIN_SIZE
    );
  const sizes = rocks.map((rock) => rock.size);
  expect(Math.min(...sizes)).toBeLessThan(ROID.DEPOSIT_SIZE_MIN + 2);
  expect(Math.max(...sizes)).toBeGreaterThan(ROID.DEPOSIT_SIZE_MAX - 6);
  expect(Math.max(...sizes)).toBeLessThan(ROID.COLOSSAL_MIN_SIZE);
  // Small rocks outnumber boulders, but large rocks stay common.
  expect(sizes.filter((size) => size < 30).length).toBeGreaterThan(
    sizes.filter((size) => size >= 60).length
  );
  expect(sizes.filter((size) => size >= 60).length / sizes.length).toBeGreaterThan(0.1);

  const speeds = rocks
    .filter((rock) => !isStationary(rock))
    .map((rock) => Math.hypot(rock.velocity.x, rock.velocity.y));
  expect(Math.max(...speeds)).toBeLessThanOrEqual(ROID.SERVER_VELOCITY_MAX + 1e-9);
  expect(speeds.filter((speed) => speed >= ROID.FAST_DRIFT_SPEED_MIN).length).toBeGreaterThan(0);
  expect(speeds.filter((speed) => speed < ROID.DRIFT_SPEED_MAX / 3).length).toBeGreaterThan(
    speeds.length / 3
  );

  const spins = rocks.map((rock) => Math.abs(rock.angularVelocity));
  expect(rocks.some((rock) => rock.angularVelocity < 0)).toBe(true);
  expect(rocks.some((rock) => rock.angularVelocity > 0)).toBe(true);
  expect(Math.max(...spins)).toBeGreaterThan(ROID.SPIN_MAX * 0.5);
  expect(spins.filter((spin) => spin < ROID.SPIN_MAX / 4).length).toBeGreaterThan(spins.length / 2);

  // Small rocks drift and spin faster on average.
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const small = rocks.filter((rock) => rock.size < 25);
  const large = rocks.filter((rock) => rock.size > 60);
  expect(mean(small.map((rock) => Math.abs(rock.angularVelocity)))).toBeGreaterThan(
    mean(large.map((rock) => Math.abs(rock.angularVelocity)))
  );

  const outlines = new Set(rocks.map((rock) => rock.offsets.join(',')));
  expect(outlines.size).toBeGreaterThan(rocks.length * 0.9);
  expect(new Set(rocks.map((rock) => rock.vertices)).size).toBeGreaterThan(4);
  for (const rock of rocks) {
    expect(rock.vertices).toBe(rock.offsets.length);
  }
});

test('a mined deposit regrows in its home slot only after an interval and out of sight', () => {
  const observer = { x: -900, y: -900 };
  const { field, manager } = awakeField(observer);
  const [first, second] = hiddenSlots(manager, observer);
  if (!first || !second) {
    throw new Error('Sector 0,0 needs two hidden ordinary slots');
  }
  const home = structuredClone(first);
  manager.removeAsteroid(first.id);
  manager.removeAsteroid(second.id);

  // Nothing regrows before the sector's next interval.
  expect(field.update(manager, [observer], T0 + INTERVAL - 1)).toEqual([]);
  // One slot per interval, restored exactly as generated.
  const grown = field.update(manager, [observer], T0 + INTERVAL);
  expect(grown).toHaveLength(1);
  expect(manager.getAsteroid(first.id)).toEqual(home);
  expect(manager.getAsteroid(second.id)).toBeUndefined();
  field.update(manager, [observer], T0 + INTERVAL * 2);
  expect(manager.getAsteroid(second.id)).toBeDefined();
});

test('neither a pilot radar nor a survey probe watches a mined deposit reappear', () => {
  const observer = { x: -900, y: -900 };
  const { field, manager } = awakeField(observer);
  const [target] = hiddenSlots(manager, observer);
  if (!target) {
    throw new Error('Sector 0,0 needs a hidden ordinary slot');
  }
  manager.removeAsteroid(target.id);
  // A pilot whose radar edge covers the slot, then a probe at the edge of a
  // scanning pilot's zoomed-out view: both would see a rock appear.
  const radarPilot = { x: target.position.x - WORLD.asteroidInterestRadius, y: target.position.y };
  const probe = { x: target.position.x, y: target.position.y + WORLD.interestRadius - 1 };
  let now = T0;
  for (const watcher of [radarPilot, probe]) {
    for (let step = 0; step < 4; step++) {
      now += INTERVAL;
      field.update(manager, [observer, watcher], now);
    }
    expect(manager.getAsteroid(target.id)).toBeUndefined();
  }
  // Once nobody can see it, the slot fills on the next interval.
  field.update(manager, [observer], now + INTERVAL);
  expect(manager.getAsteroid(target.id)).toBeDefined();
});

test('a deposit carried into a sleeping sector is never duplicated by regrowth', () => {
  const observer = { x: -900, y: -900 };
  const { field, manager } = awakeField(observer);
  const [traveler] = hiddenSlots(manager, observer);
  if (!traveler) {
    throw new Error('Sector 0,0 needs a hidden ordinary slot');
  }
  // Drift carries it far away; the checkpoint puts that sector to sleep with the rock.
  traveler.position = { x: 5.5 * WORLD.sectorSize, y: 5.5 * WORLD.sectorSize };
  traveler.velocity = { x: 0, y: 0 };
  field.checkpoint(manager);
  expect(manager.getAsteroid(traveler.id)).toBeUndefined();

  for (let step = 1; step <= 4; step++) {
    field.update(manager, [observer], T0 + INTERVAL * step);
  }
  expect(idCount(field, manager, traveler.id)).toBe(1);
});

test('a sector that slept catches up on the regrowth it missed', () => {
  const observer = { x: -900, y: -900 };
  const { field, manager } = awakeField(observer);
  const mined = hiddenSlots(manager, observer).slice(0, 5);
  for (const rock of mined) {
    manager.removeAsteroid(rock.id);
  }
  // Leave for three intervals; the sector sleeps while the crew is away.
  field.update(manager, [{ x: -30_000, y: 0 }], T0 + 1);
  expect(field.dormantSectors().has('0,0')).toBe(true);
  field.update(manager, [observer], T0 + 1 + INTERVAL * 3);
  expect(mined.filter((rock) => manager.getAsteroid(rock.id))).toHaveLength(3);
});

test('a world saved under an older layout keeps its rocks and refills over a few minutes', () => {
  const layout = sectorDeposits(SEED, 0, 0);
  const kept = layout.find((rock) => !rock.phenomenon && !rock.isCollabTarget);
  if (!kept) {
    throw new Error('Sector 0,0 needs an ordinary slot');
  }
  const survivor = { ...structuredClone(kept), position: { x: 1_900, y: 1_900 }, health: 5 };
  const retired = {
    ...structuredClone(kept),
    id: `deposit-${SEED}-0-0-9999`,
    position: { x: 1_800, y: 1_800 },
  };
  const field = new RegionalAsteroidField(SEED, new Map([['0,0', [survivor, retired]]]));
  const manager = new AsteroidManager(new RNGService(SEED));
  const observer = { x: -900, y: -900 };
  const hidden = layout.filter(
    (rock) =>
      rock.id !== survivor.id &&
      Math.hypot(rock.position.x - observer.x, rock.position.y - observer.y) >=
        DEPOSIT_FIELD.REGROWTH_HIDDEN_DISTANCE
  );
  const regrown = () => hidden.filter((rock) => manager.getAsteroid(rock.id)).length;
  expect(hidden.length).toBeGreaterThan(20);

  // A restart is not a refill: saved rows load exactly as they were.
  field.update(manager, [observer], T0);
  expect(manager.getAsteroid(survivor.id)).toEqual(survivor);
  expect(manager.getAsteroid(retired.id)).toEqual(retired);
  expect(regrown()).toBe(0);

  // Three minutes of play restores roughly half of a stripped sector.
  const minute = 60_000;
  for (let now = T0 + INTERVAL; now <= T0 + 3 * minute; now += INTERVAL) {
    field.update(manager, [observer], now);
  }
  expect(regrown()).toBeGreaterThan(hidden.length * 0.4);
  expect(regrown()).toBeLessThan(hidden.length * 0.8);

  for (let now = T0 + 3 * minute + INTERVAL; now <= T0 + 30 * minute; now += INTERVAL) {
    field.update(manager, [observer], now);
  }
  expect(regrown()).toBe(hidden.length);
  expect(idCount(field, manager, survivor.id)).toBe(1);
  expect(manager.getAsteroid(survivor.id)?.position).toEqual({ x: 1_900, y: 1_900 });
});

test('checkpoints persist mined sectors at once and drift-only sectors on a slower cadence', () => {
  const observer = { x: 1_000, y: 1_000 };
  const { field, manager } = awakeField(observer);
  const first = field.checkpoint(manager);
  field.saved();
  expect(first.has('0,0')).toBe(true);

  // Spin and chip damage change rows without moving any rock across an edge.
  for (const rock of manager.getAllAsteroids()) {
    rock.rotation += rock.angularVelocity;
    rock.health = Math.max(1, rock.health - 1);
  }
  expect([...field.checkpoint(manager).keys()]).toEqual([]);
  field.saved();

  const mined = manager.getAllAsteroids().find((rock) => sectorAt(rock.position).id === '0,0');
  if (!mined) {
    throw new Error('Sector 0,0 needs a rock');
  }
  manager.removeAsteroid(mined.id);
  const minedBatch = field.checkpoint(manager);
  field.saved();
  expect([...minedBatch.keys()]).toEqual(['0,0']);
  expect(minedBatch.get('0,0')?.some((rock) => rock.id === mined.id)).toBe(false);

  let drift: ReadonlyMap<string, AsteroidData[]> = new Map();
  for (let index = 3; index <= WORLD.driftFlushCheckpoints; index++) {
    drift = field.checkpoint(manager);
    field.saved();
  }
  const awake = new Set(manager.getAllAsteroids().map((rock) => sectorAt(rock.position).id));
  expect(awake.size).toBeGreaterThan(1);
  for (const id of awake) {
    expect(drift.has(id)).toBe(true);
  }
});

test('a rock drifting between two awake sectors is saved once and never regrows twice after a reload', () => {
  const observer = { x: 1_000, y: 1_000 };
  const { field, manager } = awakeField(observer);
  const saved = new Map(field.checkpoint(manager));
  field.saved();
  const traveler = manager
    .getAllAsteroids()
    .find((rock) => rock.id.startsWith(`deposit-${SEED}-0-0-`) && !rock.phenomenon);
  if (!traveler) {
    throw new Error('Sector 0,0 needs an ordinary deposit');
  }
  // Not a drift flush: only the two sectors whose rock sets changed are written.
  manager.updateAsteroid(traveler.id, { position: { x: 2_100, y: 500 } });
  const batch = field.checkpoint(manager);
  field.saved();
  expect([...batch.keys()].sort()).toEqual(['0,0', '1,0']);
  expect(batch.get('0,0')?.some((rock) => rock.id === traveler.id)).toBe(false);
  expect(batch.get('1,0')?.filter((rock) => rock.id === traveler.id)).toHaveLength(1);

  for (const [id, rows] of batch) {
    saved.set(id, rows);
  }
  const reloaded = new RegionalAsteroidField(SEED, structuredClone(saved));
  const reloadedManager = new AsteroidManager(new RNGService(SEED));
  for (let step = 0; step <= 20; step++) {
    reloaded.update(reloadedManager, [{ x: -900, y: -900 }], T0 + step * INTERVAL);
  }
  expect(idCount(reloaded, reloadedManager, traveler.id)).toBe(1);
});

test('the last pilot leaving writes chip damage that periodic flushes defer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-drift-flush-'));
  try {
    const path = join(directory, 'world.sqlite');
    const store = new WorldStore(path);
    const engine = new GameEngine(SEED, undefined, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    engine.addPlayer('miner', 'Miner', socket, { x: 900, y: 900 }, 'scout');
    engine.ensureAsteroidField();
    engine.checkpointWorld();
    const chipped = engine
      .getAllAsteroids()
      .find((rock) => rock.material === 'metal' && !rock.phenomenon && rock.health > 25);
    if (!chipped) {
      throw new Error('The field needs an intact metal deposit');
    }
    const home = sectorAt(chipped.position).id;
    engine.updateAsteroid(chipped.id, { health: chipped.health - 25 });
    // The next periodic flush is not a drift flush, so the chip would wait.
    engine.checkpointWorld();
    expect(store.loadSector(home)?.find((rock) => rock.id === chipped.id)?.health).toBe(
      chipped.health + 25
    );
    engine.removePlayer('miner');
    expect(engine.isGamePaused()).toBe(true);
    engine.stopGameLoop();
    store.close();

    const reopened = new WorldStore(path);
    expect(reopened.loadSector(home)?.find((rock) => rock.id === chipped.id)?.health).toBe(
      chipped.health
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
