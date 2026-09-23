/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { FURNACES } from '../../../shared/furnaces';
import { sectorAt, WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

const stores: WorldStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const closedStore of stores.splice(0)) {
    closedStore.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store(): WorldStore {
  const value = new WorldStore(':memory:');
  stores.push(value);
  return value;
}

function temporaryWorldPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-mining-'));
  temporaryDirectories.push(directory);
  return join(directory, 'world.sqlite');
}

function fileStore(path: string): WorldStore {
  const value = new WorldStore(path);
  stores.push(value);
  return value;
}

function closeStore(value: WorldStore): void {
  const index = stores.indexOf(value);
  if (index >= 0) {
    stores.splice(index, 1);
  }
  value.close();
}

function pilot(
  engine: GameEngine,
  id: string,
  position = { x: 0, y: 0 },
  kit: 'scout' | 'hauler' = 'scout'
) {
  const socket = new RecordingSocket();
  const actor = engine.addPlayer(id, id, socket, position, kit);
  actor.asteroidInteractions = 1;
  const registered = engine.registerPilot(actor, socket);
  assert(registered.ok);
  return actor;
}

function largeIce(id: string): AsteroidData {
  return {
    id,
    position: { x: 400, y: 300 },
    velocity: { x: 0, y: 0 },
    size: 50,
    material: 'ice',
    health: 50,
    maxHealth: 50,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

function highHpIce(id: string): AsteroidData {
  return {
    ...largeIce(id),
    isCollabTarget: true,
    health: 100,
    maxHealth: 100,
  };
}

function metalDeposit(id: string): AsteroidData {
  return {
    ...largeIce(id),
    size: 25,
    material: 'metal',
    health: 75,
    maxHealth: 75,
  };
}

test('a flush that cannot save every delivered score rolls the whole batch back and stops gameplay', () => {
  const path = temporaryWorldPath();
  const worldStore = fileStore(path);
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const furnace = FURNACES[0];
  assert(furnace);
  const first = pilot(engine, 'first-hauler', furnace.position, 'hauler');
  const second = pilot(engine, 'second-hauler', furnace.position, 'hauler');
  const cargos = [first, second].map((hauler) => {
    const cargo = { ...metalDeposit(`${hauler.id}-cargo`), position: { ...furnace.position } };
    engine.addAsteroid(cargo);
    hauler.harpoonTargetId = cargo.id;
    return cargo;
  });
  engine.checkpointWorld();
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TRIGGER fail_second_score BEFORE INSERT ON pilots WHEN NEW.id = 'second-hauler' BEGIN SELECT RAISE(ABORT, 'injected second score failure'); END"
    );
    // The deliveries land in memory; the failing flush is what stops the world.
    engine.processFurnaceDeliveries();
    expect(engine.drainFurnaceDeliveries()).toHaveLength(2);
    expect(() => engine.checkpointWorld()).toThrow('Persistent world checkpoint failed');
    expect(engine.isPersistenceHealthy()).toBe(false);
    expect(() => engine.advanceOneFrame()).toThrow('Persistent world checkpoint failed');
    expect(
      worldStore
        .loadPilots()
        .filter((row) => row.id.endsWith('-hauler'))
        .map((row) => row.score)
    ).toEqual([0, 0]);
    const saved = worldStore.loadSector(sectorAt(furnace.position).id);
    expect(cargos.every((cargo) => saved?.some((row) => row.id === cargo.id))).toBe(true);
  } finally {
    db.close();
  }
});

test('a collaborative laser break saves fragments and shared point loot by the next flush', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const firstMiner = pilot(engine, 'first-miner');
  const secondMiner = pilot(engine, 'second-miner', { x: 10, y: 0 });
  const target = largeIce('persisted-split-target');
  target.surveyedBy = ['first-miner', 'first-miner'];
  engine.addAsteroid(target);

  expect(engine.applyLaserAsteroidHit(target.id, firstMiner.id, 'laser', 0).outcome).toBe('tagged');
  const result = engine.applyLaserAsteroidHit(target.id, secondMiner.id, 'laser', 100);

  expect(result.outcome).toBe('destroyed');
  expect(result.newAsteroids).toHaveLength(2);
  expect(engine.getLoot().find((drop) => drop.kind === 'points')?.points).toBe(ROID.POINTS_LARGE);
  expect(firstMiner.score).toBe(0);
  expect(secondMiner.score).toBe(0);
  engine.checkpointWorld();
  const saved = worldStore.loadPilots();
  expect(saved.find((savedPilot) => savedPilot.id === firstMiner.id)?.score).toBe(0);
  expect(saved.find((savedPilot) => savedPilot.id === secondMiner.id)?.score).toBe(0);
  const rows = worldStore.loadSector('0,0');
  assert(rows);
  expect(rows.some((sectorRock) => sectorRock.id === target.id)).toBe(false);
  expect(
    result.newAsteroids.every((fragment) =>
      rows.some((sectorRock) => sectorRock.id === fragment.id)
    )
  ).toBe(true);
});

test('expired collaborative mining leaves collectible points instead of paying an offline miner and Scout by the next flush', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const miner = pilot(engine, 'offline-miner');
  const active = pilot(engine, 'active-pilot', { x: 10, y: 0 });
  const scout = pilot(engine, 'survey-contributor', { x: 20, y: 0 });
  const target = largeIce('persisted-expiry-target');
  target.surveyedBy = [scout.id];
  engine.addAsteroid(target);

  expect(engine.applyLaserAsteroidHit(target.id, miner.id, 'laser', 0).outcome).toBe('tagged');
  engine.removePlayer(miner.id);
  const expired = engine.flushExpiredCollabHits(ROID.COLLAB_SPLIT_WINDOW_MS + 1);

  expect(expired[0]?.contributors).toEqual([miner.id, scout.id]);
  expect(active.score).toBe(0);
  expect(scout.score).toBe(0);
  engine.checkpointWorld();
  expect(worldStore.loadPilots().find((savedPilot) => savedPilot.id === miner.id)?.score).toBe(0);
  expect(worldStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test('a high-HP rock leaves collectible points instead of paying an offline first Hauler when a second Hauler finishes it', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const firstMiner = pilot(engine, 'offline-high-hp', { x: 0, y: 0 }, 'hauler');
  const terminalMiner = pilot(engine, 'terminal-high-hp', { x: 10, y: 0 }, 'hauler');
  const target = highHpIce('persisted-high-hp-target');
  engine.addAsteroid(target);

  expect(engine.handleAsteroidDamage(target.id, firstMiner.id).destroyed).toBe(false);
  expect(target.health).toBe(50);
  expect(target.miningContributors).toEqual([firstMiner.id]);
  engine.removePlayer(firstMiner.id);
  expect(engine.handleAsteroidDamage(target.id, terminalMiner.id).destroyed).toBe(true);

  expect(terminalMiner.score).toBe(0);
  engine.checkpointWorld();
  expect(worldStore.loadPilots().find((savedPilot) => savedPilot.id === firstMiner.id)?.score).toBe(
    0
  );
  expect(worldStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test('a regional unload and reload keeps partial mining contributors on the rock', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const firstMiner = pilot(engine, 'regional-first', { x: 0, y: 0 }, 'hauler');
  const terminalMiner = pilot(engine, 'regional-terminal', { x: 10, y: 0 }, 'hauler');
  const target = highHpIce('regional-mining-target');
  engine.addAsteroid(target);

  expect(engine.handleAsteroidDamage(target.id, firstMiner.id).destroyed).toBe(false);
  engine.removePlayer(firstMiner.id);
  terminalMiner.position = { x: 40_000, y: 40_000 };
  engine.ensureAsteroidField();
  expect(engine.getAsteroid(target.id)).toBeUndefined();

  terminalMiner.position = { x: 10, y: 0 };
  engine.ensureAsteroidField();
  const reloaded = engine.getAsteroid(target.id);
  assert(reloaded);
  expect(reloaded.health).toBe(50);
  expect(reloaded.miningContributors).toEqual([firstMiner.id]);

  expect(engine.handleAsteroidDamage(reloaded.id, terminalMiner.id).destroyed).toBe(true);
  expect(terminalMiner.score).toBe(0);
  engine.checkpointWorld();
  expect(worldStore.loadPilots().find((savedPilot) => savedPilot.id === firstMiner.id)?.score).toBe(
    0
  );
});

test('a metal chip leaves collectible points instead of paying an offline first Hauler when a Scout lands the terminal hit', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const firstMiner = pilot(engine, 'offline-metal', { x: 0, y: 0 }, 'hauler');
  const terminalMiner = pilot(engine, 'terminal-metal', { x: 10, y: 0 });
  const target = metalDeposit('persisted-metal-target');
  engine.addAsteroid(target);

  expect(engine.handleAsteroidHit(target.id, firstMiner.id, 'laser').outcome).toBe('tagged');
  expect(target.health).toBe(25);
  expect(target.miningContributors).toEqual([firstMiner.id]);
  engine.removePlayer(firstMiner.id);
  expect(engine.handleAsteroidHit(target.id, terminalMiner.id, 'laser').outcome).toBe('destroyed');

  expect(terminalMiner.score).toBe(0);
  engine.checkpointWorld();
  expect(worldStore.loadPilots().find((savedPilot) => savedPilot.id === firstMiner.id)?.score).toBe(
    0
  );
  expect(worldStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test('a partially mined high-HP rock keeps its offline contributor after restart', () => {
  const path = temporaryWorldPath();
  const firstStore = fileStore(path);
  const firstEngine = new GameEngine(82, undefined, new InlineWorldPersistence(firstStore));
  const firstMiner = pilot(firstEngine, 'restart-high-hp-first', { x: 0, y: 0 }, 'hauler');
  pilot(firstEngine, 'restart-high-hp-terminal', { x: 10, y: 0 }, 'hauler');
  const target = highHpIce('restart-high-hp-target');
  firstEngine.addAsteroid(target);

  expect(firstEngine.handleAsteroidDamage(target.id, firstMiner.id).destroyed).toBe(false);
  expect(target.miningContributors).toEqual([firstMiner.id]);
  firstEngine.checkpointWorld();
  closeStore(firstStore);

  const resumedStore = fileStore(path);
  const resumedEngine = new GameEngine(999, undefined, new InlineWorldPersistence(resumedStore));
  const terminalMiner = pilot(resumedEngine, 'restart-high-hp-terminal', { x: 10, y: 0 }, 'hauler');
  const resumedTarget = resumedEngine.getAsteroid(target.id);
  assert(resumedTarget);
  expect(resumedTarget.health).toBe(50);
  expect(resumedTarget.miningContributors).toEqual([firstMiner.id]);

  expect(resumedEngine.handleAsteroidDamage(resumedTarget.id, terminalMiner.id).destroyed).toBe(
    true
  );
  expect(terminalMiner.score).toBe(0);
  resumedEngine.checkpointWorld();
  expect(
    resumedStore.loadPilots().find((savedPilot) => savedPilot.id === firstMiner.id)?.score
  ).toBe(0);
  expect(resumedStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test('a partially mined metal deposit keeps its offline contributor after restart', () => {
  const path = temporaryWorldPath();
  const firstStore = fileStore(path);
  const firstEngine = new GameEngine(82, undefined, new InlineWorldPersistence(firstStore));
  const firstMiner = pilot(firstEngine, 'restart-metal-first', { x: 0, y: 0 }, 'hauler');
  pilot(firstEngine, 'restart-metal-terminal', { x: 10, y: 0 });
  const target = metalDeposit('restart-metal-target');
  firstEngine.addAsteroid(target);

  expect(firstEngine.handleAsteroidHit(target.id, firstMiner.id, 'laser').outcome).toBe('tagged');
  expect(target.health).toBe(25);
  expect(target.miningContributors).toEqual([firstMiner.id]);
  firstEngine.checkpointWorld();
  closeStore(firstStore);

  const resumedStore = fileStore(path);
  const resumedEngine = new GameEngine(999, undefined, new InlineWorldPersistence(resumedStore));
  const terminalMiner = pilot(resumedEngine, 'restart-metal-terminal', { x: 10, y: 0 });
  const resumedTarget = resumedEngine.getAsteroid(target.id);
  assert(resumedTarget);
  expect(resumedTarget.health).toBe(25);
  expect(resumedTarget.miningContributors).toEqual([firstMiner.id]);

  expect(resumedEngine.handleAsteroidHit(resumedTarget.id, terminalMiner.id, 'laser').outcome).toBe(
    'destroyed'
  );
  expect(terminalMiner.score).toBe(0);
  resumedEngine.checkpointWorld();
  expect(
    resumedStore.loadPilots().find((savedPilot) => savedPilot.id === firstMiner.id)?.score
  ).toBe(0);
  expect(resumedStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test('an accidental hull break leaves points without banking credit for an offline miner and Scout', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const miner = pilot(engine, 'collision-miner', { x: 0, y: 0 }, 'hauler');
  const scout = pilot(engine, 'collision-scout', { x: 10, y: 0 });
  const rammer = pilot(engine, 'collision-finisher', { x: 20, y: 0 });
  const target = highHpIce('collision-cargo');
  target.surveyedBy = [scout.id];
  engine.addAsteroid(target);
  expect(engine.handleAsteroidDamage(target.id, miner.id).destroyed).toBe(false);
  engine.removePlayer(miner.id);
  engine.removePlayer(scout.id);

  const result = engine.handleAsteroidHit(target.id, rammer.id, 'collision');
  expect(result.outcome).toBe('destroyed');
  expect(result.split).toBe(false);
  expect(result.newAsteroids).toHaveLength(0);
  expect(rammer.score).toBe(0);
  engine.checkpointWorld();
  for (const id of [miner.id, scout.id]) {
    expect(worldStore.loadPilots().find((savedPilot) => savedPilot.id === id)?.score).toBe(0);
  }
  expect(worldStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test('a terminal reflected shot credits the offline pilot who first charged the rock', () => {
  const worldStore = store();
  const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
  const first = pilot(engine, 'first-reflector', { x: -500, y: 0 });
  const second = pilot(engine, 'last-reflector', { x: -500, y: 10 });
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  const target: AsteroidData = {
    ...metalDeposit('shared-reflector'),
    position: { x: 0, y: 0 },
    size: 32,
    rotation: Math.PI / 4,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    phenomenon: { kind: 'reflective', clusterId: 'shared-reflector', energy: 0, maxEnergy: 2 },
  };
  engine.addAsteroid(target);
  const firstShot = engine.spawnLaser(first.id, { x: -50, y: 0 }, { x: 40, y: 0 });
  assert(firstShot);
  engine.advanceLasersAndResolveHits();
  expect(firstShot.bounces).toBe(1);
  expect(target.miningContributors).toEqual([first.id]);
  engine.removePlayer(first.id);
  assert(engine.spawnLaser(second.id, { x: -50, y: 0 }, { x: 40, y: 0 }));
  engine.advanceLasersAndResolveHits();

  expect(engine.getAsteroid(target.id)).toBeUndefined();
  expect(second.score).toBe(0);
  engine.checkpointWorld();
  expect(worldStore.loadPilots().find((savedPilot) => savedPilot.id === first.id)?.score).toBe(0);
  expect(engine.getLoot().filter((drop) => drop.kind === 'laserCore')).toHaveLength(1);
  expect(worldStore.loadSector('0,0')?.some((sectorRock) => sectorRock.id === target.id)).toBe(
    false
  );
});

test.each(['ice', 'rubble'] as const)(
  'mining %s at the world edge saves contained fragments and shared loot by the next flush',
  (material) => {
    const worldStore = store();
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(worldStore));
    const firstMiner = pilot(engine, 'edge-first');
    const secondMiner = pilot(engine, 'edge-second', { x: 10, y: 0 });
    const target = {
      ...largeIce(`edge-${material}`),
      material,
      position: { x: WORLD.radius - 1, y: 0 },
      surveyedBy: [firstMiner.id],
    };
    engine.addAsteroid(target);
    if (material === 'ice') {
      expect(engine.applyLaserAsteroidHit(target.id, firstMiner.id, 'laser', 0).outcome).toBe(
        'tagged'
      );
    }
    const result = engine.applyLaserAsteroidHit(target.id, secondMiner.id, 'laser', 100);
    expect(result.outcome).toBe('destroyed');
    expect(result.newAsteroids).toHaveLength(material === 'rubble' ? 3 : 2);
    engine.checkpointWorld();
    for (const fragment of result.newAsteroids) {
      expect(Math.hypot(fragment.position.x, fragment.position.y)).toBeLessThanOrEqual(
        WORLD.radius
      );
      const saved = worldStore.loadSector(sectorAt(fragment.position).id);
      expect(saved?.find((rock) => rock.id === fragment.id)?.position).toEqual(fragment.position);
    }
    expect(
      worldStore
        .loadSector(sectorAt(target.position).id)
        ?.some((sectorRock) => sectorRock.id === target.id)
    ).toBe(false);
    const savedPilots = worldStore.loadPilots();
    for (const miner of [firstMiner, secondMiner]) {
      expect(savedPilots.find((saved) => saved.id === miner.id)?.score).toBe(0);
    }
  }
);
