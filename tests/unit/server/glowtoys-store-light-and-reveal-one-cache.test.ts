/* @vitest-environment node */
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { advanceGlowtoys } from '../../../server/core/GlowtoyManager';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { GAME, LASER } from '../../../shared/constants/gameplay';
import { GLOWTOY, shipIlluminates } from '../../../shared/glowtoy';
import { SHIP_ABILITY } from '../../../shared/shipKits';
import { validateAsteroidDto } from '../../../shared/snapshotDto';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';
import { spiderAdvanceFixture } from '../../support/spiderAdvanceFixture';

function rock(): AsteroidData {
  return {
    id: 'glow',
    position: { x: 180, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 30,
    health: 100,
    maxHealth: 100,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'crystal',
    glowtoy: { charge: 0, cachePosition: { x: 600, y: 0 }, cacheRevealed: false },
  };
}
const light = {
  position: { x: 0, y: 0 },
  angle: 0,
  thrusting: true,
  health: 100,
  exploding: false,
};

test('headlights and aft thrust charge crystals, charge decays, and a towed bright crystal reveals its cache once', () => {
  const target = rock();
  const rewards: unknown[] = [];
  for (let i = 0; i < 100; i++) {
    advanceGlowtoys([target], [light], (position) => rewards.push(position));
  }
  expect(target.glowtoy?.charge).toBe(1);
  expect(rewards).toEqual([]);
  target.position.x = 400;
  for (let i = 0; i < 10; i++) {
    advanceGlowtoys([target], [light], (position) => rewards.push(position));
  }
  expect(rewards).toEqual([{ x: 600, y: 0 }]);
  const restored: AsteroidData = JSON.parse(JSON.stringify(target));
  validateAsteroidDto(restored);
  advanceGlowtoys([restored], [light], (position) => rewards.push(position));
  expect(rewards).toHaveLength(1);
  for (let i = 0; i < 130; i++) {
    advanceGlowtoys([target], [], (position) => rewards.push(position));
  }
  expect(target.glowtoy?.charge).toBe(0);
  expect(shipIlluminates(light, { x: -80, y: 0 })).toBe(true);
  expect(shipIlluminates({ ...light, thrusting: false }, { x: -80, y: 0 })).toBe(false);
  expect(shipIlluminates(light, { x: 0, y: 80 })).toBe(false);
  expect(shipIlluminates({ ...light, exploding: true }, { x: 30, y: 0 })).toBe(false);
});

test('authoritative laser contact is absorbed as charge without damage or repeated hit rewards', () => {
  const engine = new GameEngine(123);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
  pilot.position = { x: 0, y: 0 };
  pilot.angle = 0;
  pilot.spawnProtectionTimer = 0;
  for (const row of engine.getAllAsteroids()) {
    engine.removeAsteroid(row.id);
  }
  const target = rock();
  engine.addAsteroid(target);
  const projectile = engine.spawnPlayerLaser(
    pilot.id,
    { x: 40, y: 0 },
    { x: LASER.SPEED / GAME.FPS, y: 0 }
  );
  expect(projectile).toBeTruthy();
  for (let i = 0; i < 100; i++) {
    engine.advanceLasersAndResolveHits();
  }
  expect(engine.getAsteroid(target.id)?.health).toBe(100);
  expect(target.glowtoy?.charge).toBe(GLOWTOY.laserCharge);
  expect(engine.getLoot()).toEqual([]);
});

test('bright rocks draw neutral roaming spiders without inventing an attack target', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const spider = manager.spawnSpider({ x: 8000, y: 8000 }, Math.PI);
  if (!spider) {
    throw new Error('Expected roamer');
  }
  const lightPosition = { x: 8300, y: 8000 };
  manager.advance(
    spiderAdvanceFixture({
      nowFrame: 1,
      players: [
        { id: 'pilot', position: { x: 9000, y: 8500 }, health: 100, exploding: false, radius: 20 },
      ],
      lightSources: [lightPosition],
    })
  );
  const attracted = manager.getBodies().find((row) => row.id === spider.id);
  expect(attracted?.position.x).toBeGreaterThan(8000);
  expect(attracted?.targetId).toBeNull();
});

test('a scanner at the edge of its reach still repels a spider despite a nearby bright rock', () => {
  const manager = new TerrainSpiderManager(() => 0.5);
  const spider = manager.spawnSpider({ x: 8000, y: 8000 }, Math.PI);
  if (!spider) {
    throw new Error('Expected roamer');
  }
  manager.advance(
    spiderAdvanceFixture({
      nowFrame: 1,
      players: [
        {
          id: 'scanner',
          position: { x: 8000 - SHIP_ABILITY.SCAN_RANGE + 0.1, y: 8000 },
          health: 100,
          exploding: false,
          radius: 20,
          scanning: true,
        },
      ],
      lightSources: [{ x: 7900, y: 8000 }],
    })
  );
  expect(manager.getBodies().find((row) => row.id === spider.id)?.position.x).toBeGreaterThan(8000);
});

test('cache reveal and cargo persist in the same next-second batch, even between drift checkpoints', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(123, undefined, new InlineWorldPersistence(store));
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
  engine.pilotSessions.register({ actor: pilot, socket: socket });
  pilot.position = { x: 0, y: 0 };
  for (const row of engine.getAllAsteroids()) {
    engine.removeAsteroid(row.id);
  }
  const target = rock();
  target.glowtoy = { charge: 0.95, cachePosition: { x: 400, y: 0 }, cacheRevealed: false };
  engine.addAsteroid(target);
  engine.checkpointWorld();
  const commits = vi.spyOn(store, 'checkpoint');
  let restored: GameEngine | undefined;
  try {
    for (let i = 1; i < GLOWTOY.tickFrames; i++) {
      engine.advanceOneFrame();
    }
    expect(target.glowtoy.charge).toBe(0.95);
    expect(target.glowtoy.cacheRevealed).toBe(false);
    expect(engine.getLoot().filter((drop) => drop.kind === 'points')).toEqual([]);
    engine.advanceOneFrame();
    expect(target.glowtoy.charge).toBe(0.95 + GLOWTOY.chargePerTick);
    expect(target.glowtoy.cacheRevealed).toBe(true);
    expect(commits).not.toHaveBeenCalled();
    engine.checkpointWorld();
    const saved = store.loadSector('0,0')?.find((row) => row.id === target.id);
    expect(saved?.glowtoy?.cacheRevealed).toBe(true);
    const rewards = engine.getLoot().filter((drop) => drop.kind === 'points');
    expect(rewards).toHaveLength(1);
    const reward = rewards[0];
    if (!reward) {
      throw new Error('Expected revealed cache reward');
    }
    expect(store.load().economy?.pointLoot).toEqual([
      expect.objectContaining({ id: reward.id, position: reward.position, points: reward.points }),
    ]);
    expect(commits).toHaveBeenCalledOnce();
    engine.stopGameLoop();
    restored = new GameEngine(123, undefined, new InlineWorldPersistence(store));
    const resumedSocket = new RecordingSocket();
    const resumedPilot = restored.addPlayer('returning-pilot', 'Returning pilot', resumedSocket, {
      x: 0,
      y: 0,
    });
    restored.pilotSessions.register({ actor: resumedPilot, socket: resumedSocket });
    resumedPilot.position = { x: 0, y: 0 };
    expect(restored.getAsteroid(target.id)?.glowtoy?.cacheRevealed).toBe(true);
    expect(restored.getLoot().filter((drop) => drop.kind === 'points')).toEqual([
      expect.objectContaining({ id: reward.id, position: reward.position, points: reward.points }),
    ]);
    for (let frame = 0; frame < 60; frame++) {
      restored.advanceOneFrame();
    }
    expect(
      restored
        .getLoot()
        .filter((drop) => drop.kind === 'points')
        .map((drop) => drop.id)
    ).toEqual([reward.id]);
    restored.checkpointWorld();
    expect(store.load().economy?.pointLoot.map((drop) => drop.id)).toEqual([reward.id]);
  } finally {
    commits.mockRestore();
    restored?.stopGameLoop();
    engine.stopGameLoop();
    store.close();
  }
});

test('a bright crystal guides spiders before the next glow tick, but a world reset removes that light', () => {
  const engine = new GameEngine(123);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 8000, y: 8000 });
  pilot.position = { x: 8000, y: 8000 };
  pilot.angle = 0;
  for (const row of engine.getAllAsteroids()) {
    engine.removeAsteroid(row.id);
  }
  engine.parkSatellitePickups();
  const target = rock();
  target.position = { x: 8300, y: 8000 };
  target.glowtoy = {
    charge: 0.95,
    cachePosition: { x: 10000, y: 8000 },
    cacheRevealed: false,
  };
  engine.addAsteroid(target);
  try {
    for (let i = 0; i < GLOWTOY.tickFrames; i++) {
      engine.advanceOneFrame();
    }
    pilot.position = { x: 9000, y: 8500 };
    engine.clearSpiderField();
    const attracted = engine.spawnTerrainSpider({ x: 8000, y: 8000 }, Math.PI);
    if (!attracted) {
      throw new Error('Expected roamer before reset');
    }
    engine.advanceOneFrame();
    const litSpider = engine.getSpiderField().spiders.find((row) => row.id === attracted.id);
    expect(litSpider?.position.x).toBeGreaterThan(8000);
    expect(litSpider?.targetId).toBeNull();

    engine.prepareDiagnosticWorld('traversal');
    for (const row of engine.getAllAsteroids()) {
      engine.removeAsteroid(row.id);
    }
    engine.parkSatellitePickups();
    engine.clearSpiderField();
    const unlit = engine.spawnTerrainSpider({ x: 8000, y: 8000 }, Math.PI);
    if (!unlit) {
      throw new Error('Expected roamer after reset');
    }
    engine.advanceOneFrame();
    const resetSpider = engine.getSpiderField().spiders.find((row) => row.id === unlit.id);
    expect(resetSpider?.position.x).toBeLessThan(8000);
    expect(resetSpider?.targetId).toBeNull();
  } finally {
    engine.stopGameLoop();
  }
});

test('glow processing has a fixed per-step budget even in a crowded active region', () => {
  const rows = Array.from({ length: GLOWTOY.maximumActive + 10 }, (_, i) => ({
    ...rock(),
    id: `glow-${i}`,
  }));
  advanceGlowtoys(rows, [light], () => {
    throw new Error('No nearby cache');
  });
  expect(rows.filter((row) => (row.glowtoy?.charge ?? 0) > 0)).toHaveLength(GLOWTOY.maximumActive);
});
