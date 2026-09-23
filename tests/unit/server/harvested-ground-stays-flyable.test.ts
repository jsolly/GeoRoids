/* @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { WORLD } from '../../../shared/world';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function deposit(id: string): AsteroidData {
  return {
    id,
    position: { x: 400, y: 400 },
    velocity: { x: 0, y: 0 },
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

function worldJson(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    return JSON.parse(row.json) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function writeCompletedSectors(path: string, completedSectors: unknown): void {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT json FROM world WHERE id=1').get() as { json: string };
    const world = JSON.parse(row.json) as Record<string, unknown>;
    world['completedSectors'] = completedSectors;
    db.prepare('UPDATE world SET json=? WHERE id=1').run(JSON.stringify(world));
  } finally {
    db.close();
  }
}

test('an old completed-sector list does not wall harvested ground or refill it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-harvested-ground-'));
  const path = join(directory, 'world.sqlite');
  const now = Date.now();
  const seed = 82;
  let store: WorldStore | undefined;
  let engine: GameEngine | undefined;
  try {
    const prepared = new WorldStore(path);
    prepared.checkpoint(
      {
        seed,
        startedAt: now,
        generation: WORLD.generation,
        exploration: [],
      },
      new Map([
        ['0,0', [deposit(`deposit-${seed}-0-0-0`)]],
        ['1,0', []],
      ]),
      []
    );
    prepared.close();

    writeCompletedSectors(path, { bad: true });
    const malformed = new WorldStore(path);
    expect(malformed.loadWorld()?.seed).toBe(seed);
    expect(malformed.loadWorld()).not.toHaveProperty('completedSectors');
    expect(malformed.loadSector('1,0')).toEqual([]);
    malformed.close();

    writeCompletedSectors(path, ['1,0']);
    store = new WorldStore(path);
    engine = new GameEngine(seed, undefined, new InlineWorldPersistence(store));
    const socket = new RecordingSocket();
    const outside = { x: 1_980, y: 800 };
    const pilot = engine.addPlayer('pilot', 'Pilot', socket, outside);
    expect(pilot.position).toEqual(outside);
    pilot.asteroidInteractions = 1;
    const joinedAt = engine.getServerTime();
    expect(engine.playerMotion.register(pilot, socket, 1, joinedAt).ok).toBe(true);
    const crossed = engine.playerMotion.acceptFreePose(
      socket,
      {
        epoch: 1,
        sequence: 1,
        position: { x: 2_020, y: 800 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: true,
      },
      joinedAt + 1_000
    );
    expect(crossed.ok).toBe(true);
    expect(pilot.position).toEqual({ x: 2_020, y: 800 });
    engine.ensureAsteroidField();
    const shot = engine.spawnLaser('pilot', { x: 1_980, y: 1_400 }, { x: 50, y: 0 });
    expect(shot).not.toBeNull();
    engine.advanceLasersAndResolveHits(joinedAt);
    const liveShot = engine.getServerLasers().find((laser) => laser.id === shot?.id);
    expect(liveShot?.hasExploded).toBe(false);
    expect(liveShot?.position.x).toBeGreaterThan(2_000);
    delete pilot.spawnProtectionTimer;
    for (let frame = 0; frame < 30; frame++) {
      engine.advanceOneFrame();
    }
    expect(pilot.position).toEqual({ x: 2_020, y: 800 });
    expect(pilot.health).toBeGreaterThan(0);
    expect(
      engine.getAllAsteroids().some((rock) => rock.id.startsWith(`deposit-${seed}-1-0-`))
    ).toBe(false);
    expect(engine.getAsteroid(`deposit-${seed}-0-0-0`)).toBeDefined();
    engine.revealArea({ x: 2_500, y: 200 }, 100);
    engine.checkpointWorld();
    // Only the additive belt rollout may populate this old harvest tombstone.
    // Ordinary harvested deposits remain absent; no extra rows are tolerated.
    expect(
      store
        .loadSector('1,0')
        ?.map((row) => row.id)
        .sort()
    ).toEqual([`belt-${seed}-93-0`, `belt-${seed}-96-0`]);
    engine.stopGameLoop();
    engine = undefined;
    store.close();
    store = undefined;
    expect(worldJson(path)).not.toHaveProperty('completedSectors');
  } finally {
    engine?.stopGameLoop();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
