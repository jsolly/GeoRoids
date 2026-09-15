/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { WorldStore } from '../../../server/world/WorldStore';
import { explorationCellAt, isCellExplored } from '../../../shared/exploration';
import { utcScoreSeason, WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

test('a UTC month boundary zeros scores and clears the shared world without yanking a live ship', () => {
  let monotonicMs = 1_000;
  const clock = new ServerClock({
    wallNow: () => Date.parse('2026-09-30T12:00:00.000Z'),
    monotonicNow: () => monotonicMs,
  });
  const store = new WorldStore(':memory:');
  try {
    const engine = new GameEngine(82, clock, store);
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
    expect(store.loadWorld()?.scoreSeason).toBe('2026-09');

    const placement = { ...actor.position };
    monotonicMs += 24 * 60 * 60 * 1000;
    expect(utcScoreSeason(clock.now())).toBe('2026-10');
    actor.lastUpdate = clock.now();
    engine.advanceOneFrame();

    expect(engine.getPlayer('pilot')).toBe(actor);
    expect(actor.score).toBe(0);
    expect(actor.lives).toBe(2);
    expect(actor.position).toEqual(placement);
    expect(isCellExplored(engine.getGameState().exploration, distantCell)).toBe(false);
    expect(store.loadWorld()?.scoreSeason).toBe('2026-10');
    expect(store.loadPilots().find((pilot) => pilot.id === 'pilot')?.score).toBe(0);
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});

test('a saved world missing a score season resets instead of restoring last month’s placement', () => {
  const store = new WorldStore(':memory:');
  try {
    store.checkpoint(
      {
        seed: 1,
        startedAt: 1,
        generation: WORLD.generation,
        exploration: [],
        completedSectors: [],
      },
      new Map([
        [
          '0,0',
          [
            {
              id: 'stale-ore',
              position: { x: 20, y: 20 },
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
            },
          ],
        ],
      ]),
      []
    );
    expect(store.loadWorld()?.scoreSeason).toBeUndefined();
    expect(store.loadSector('0,0')).toHaveLength(1);
    const engine = new GameEngine(99, undefined, store);
    expect(engine.getTerrainSeed()).toBe(99);
    expect(store.loadWorld()).toBeUndefined();
    expect(store.loadSector('0,0')).toBeUndefined();
    engine.stopGameLoop();
  } finally {
    store.close();
  }
});
