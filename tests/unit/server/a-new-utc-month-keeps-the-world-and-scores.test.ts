/* @vitest-environment node */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { type SavedWorld, WorldStore } from '../../../server/world/WorldStore';
import { explorationCellAt, isCellExplored } from '../../../shared/exploration';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

const staleOre = {
  id: 'stale-ore',
  position: { x: 20, y: 20 },
  velocity: { x: 0, y: 0 },
  size: 25,
  material: 'metal' as const,
  health: 75,
  maxHealth: 75,
  jaggedness: 0.2,
  rotation: 0,
  angularVelocity: 0,
  vertices: 4,
  offsets: [1, 1, 1, 1],
};

test('a UTC month boundary keeps scores, exploration, and the live ship', () => {
  let monotonicMs = 1_000;
  const clock = new ServerClock({
    wallNow: () => Date.parse('2026-09-30T12:00:00.000Z'),
    monotonicNow: () => monotonicMs,
  });
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, clock, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    const actor = engine.addPlayer('pilot', 'Bob', socket, { x: 4_000, y: 1_200 });
    actor.asteroidInteractions = 1;
    const registered = engine.registerPilot(actor, socket);
    assert(registered.ok);
    actor.score = 880;
    actor.lives = 2;
    engine.revealArea(actor.position, WORLD.sectorSize);
    engine.revealArea({ x: 40_000, y: 24_000 }, WORLD.sectorSize);
    const distantCell = explorationCellAt({ x: 40_000, y: 24_000 });
    assert(distantCell !== null);
    expect(isCellExplored(engine.getGameState().exploration, distantCell)).toBe(true);
    engine.checkpointWorld();

    const placement = { ...actor.position };
    monotonicMs += 24 * 60 * 60 * 1000;
    expect(clock.now()).toBe(Date.parse('2026-10-01T12:00:00.000Z'));
    actor.lastUpdate = clock.now();
    engine.advanceOneFrame();

    expect(engine.getPlayer('pilot')).toBe(actor);
    expect(actor.score).toBe(880);
    expect(actor.lives).toBe(2);
    expect(actor.position).toEqual(placement);
    expect(isCellExplored(engine.getGameState().exploration, distantCell)).toBe(true);
    expect(store.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(880);
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});

test('a saved world from an older month restores its ore and drops the season key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-season-'));
  const path = join(directory, 'world.sqlite');
  const store = new WorldStore(path);
  try {
    store.checkpoint(
      {
        seed: 1,
        startedAt: 1,
        generation: WORLD.generation,
        exploration: [],
        scoreSeason: '2020-01',
      } as SavedWorld,
      new Map([['0,0', [staleOre]]]),
      []
    );
    const engine = new GameEngine(99, undefined, new InlineWorldPersistence(store));
    expect(engine.getTerrainSeed()).toBe(1);
    expect(store.loadSector('0,0')?.some((rock) => rock.id === 'stale-ore')).toBe(true);
    engine.checkpointWorld();
    engine.stopGameLoop();
    store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    db.close();
    expect(JSON.parse(row.json)).not.toHaveProperty('scoreSeason');
    expect(JSON.parse(row.json).seed).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a saved world without a score season restores its ore', () => {
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: 1,
        startedAt: 1,
        generation: WORLD.generation,
        exploration: [],
      },
      new Map([['0,0', [staleOre]]]),
      []
    );
    const engine = new GameEngine(99, undefined, new InlineWorldPersistence(store));
    expect(engine.getTerrainSeed()).toBe(1);
    expect(store.loadSector('0,0')).toHaveLength(1);
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});

test('a different world generation still starts a fresh expedition', () => {
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: 1,
        startedAt: 1,
        generation: WORLD.generation + 1,
        exploration: [],
      },
      new Map([['0,0', [staleOre]]]),
      []
    );
    const engine = new GameEngine(99, undefined, new InlineWorldPersistence(store));
    expect(engine.getTerrainSeed()).toBe(99);
    expect(store.loadWorld()).toBeUndefined();
    expect(store.loadSector('0,0')).toBeUndefined();
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});
