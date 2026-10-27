import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { ROID } from '../../../shared/constants/gameplay';
import { cargoCapacity } from '../../../shared/economy';
import { GROWTH } from '../../../shared/shipGrowth';
import { RecordingSocket } from '../../support/recordingSocket';

function addSmallAsteroid(engine: GameEngine, id: string, size = 12): void {
  engine.addAsteroid({
    id,
    position: { x: 20, y: 30 },
    velocity: { x: 2, y: -1 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 10,
    maxHealth: 10,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  });
}

describe('destroying asteroids drops shared shards into game state', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(99);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('destroying a roid drops a shared shard in game state', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);

    const result = engine.handleAsteroidHit('roid-1', player.id, 'laser');

    expect(result.outcome).toBe('destroyed');
    const shards = engine.getLoot().filter((drop) => drop.kind === 'shard');
    expect(shards).toHaveLength(1);
    expect(shards[0]?.position).toEqual({ x: 20, y: 30 });
    expect(shards[0]?.mass).toBe(GROWTH.SHARD_MASS);
    expect(engine.getGameState().loot).toHaveLength(2);
    expect(engine.getDiagnostics().loot).toBe(2);
    expect(player.score).toBe(0);
  });

  test('collecting a shard awards cargo without changing hull mass or health', () => {
    const ws = new RecordingSocket();
    const player = engine.addPlayer('p1', 'Pilot', ws, { x: 20, y: 30 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);
    engine.handleAsteroidHit('roid-1', player.id, 'laser');
    const beforeMass = player.mass;
    const beforeHealth = { health: player.health, maxHealth: player.maxHealth };

    const drops = engine.getLoot();
    expect(drops).toHaveLength(2);
    expect(engine.collectLoot()).toBeUndefined();
    expect(player.mass).toBe(beforeMass);
    expect(player).toMatchObject(beforeHealth);
    expect(player.cargo).toBe(ROID.POINTS_SMALL + GROWTH.SHARD_SCORE);
    expect(engine.getLoot().filter((drop) => drop.kind !== 'points')).toHaveLength(0);
    const broadcaster = new GameStateBroadcaster(engine);
    broadcaster.broadcastGameState();
    broadcaster.broadcastGameState();
    const notifications = ws.inbox.filter((message) => message.type === 'lootCollected');
    expect(notifications).toHaveLength(2);
    expect(notifications.map((message) => message.data)).toEqual(
      expect.arrayContaining(
        drops.map((drop) => ({
          eventId: expect.any(String),
          lootId: drop.id,
          collectorId: player.id,
          kind: drop.kind,
          position: { x: 20, y: 30 },
        }))
      )
    );
    expect(engine.drainLootCollections()).toEqual([]);
  });

  test('returning for the same points drop creates a distinct collection receipt', () => {
    const player = engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 20, y: 30 });
    player.spawnProtectionTimer = 0;
    player.cargo = cargoCapacity(player.kitId) - GROWTH.SHARD_SCORE - 1;
    addSmallAsteroid(engine, 'partial-rock', 12);
    engine.handleAsteroidHit('partial-rock', player.id, 'laser');
    const points = engine.getLoot().find((drop) => drop.kind === 'points');
    assert.ok(points && typeof points.points === 'number');
    player.position = { ...points.position };
    engine.collectLoot();
    const first = engine.drainLootCollections().find((event) => event.lootId === points.id);
    assert.ok(first);
    expect(player.cargo).toBe(cargoCapacity(player.kitId));
    expect(engine.getLoot().find((drop) => drop.id === points.id)?.points).toBe(points.points - 1);
    expect(first).toMatchObject({ collectorId: player.id, lootId: points.id, kind: 'points' });
    player.cargo = 0;
    engine.collectLoot();
    const second = engine.drainLootCollections().find((event) => event.lootId === points.id);
    assert.ok(second);
    expect(second).toMatchObject({ collectorId: player.id, lootId: points.id, kind: 'points' });
    expect(player.cargo).toBe(points.points - 1);
    expect(engine.getLoot().some((drop) => drop.id === points.id)).toBe(false);
    expect(first.eventId).toEqual(expect.any(String));
    expect(second.eventId).toEqual(expect.any(String));
    expect(second.eventId).not.toBe(first.eventId);
  });

  test('ending a world discards pickup sounds that have not been broadcast', () => {
    const player = engine.addPlayer('p1', 'Pilot', new RecordingSocket(), { x: 20, y: 30 });
    addSmallAsteroid(engine, 'roid-1');
    engine.handleAsteroidHit('roid-1', player.id, 'laser');
    engine.collectLoot();
    expect(engine.getLoot()).toEqual([]);
    engine.resetForTesting();
    expect(engine.drainLootCollections()).toEqual([]);
  });

  test('shooting a shard detonates it while preserving every crew hull', () => {
    const ws = new RecordingSocket();
    const shooter = engine.addPlayer('p1', 'Pilot', ws, { x: 20, y: 30 });
    const bystander = engine.addPlayer('p2', 'Near', ws, { x: 36, y: 30 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.entityManager.updateEntity('p2', { spawnProtectionTimer: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);
    engine.handleAsteroidHit('roid-1', shooter.id, 'laser');
    const shard = engine.getLoot().find((drop) => drop.kind === 'shard');
    assert.ok(shard, 'shard loot');

    const healthBefore = bystander.health;
    const blast = engine.handleLootExplode(shooter.id, shard.id);

    expect(blast.success).toBe(true);
    expect(engine.getLoot().filter((drop) => drop.kind !== 'points')).toHaveLength(0);
    expect(bystander.health).toBe(healthBefore);
    expect(shooter.health).toBe(100);
  });

  test('blast pushes small roids away and leaves big ones', () => {
    const ws = new RecordingSocket();
    const shooter = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    engine.addAsteroid({
      id: 'seed-roid',
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 12,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    engine.addAsteroid({
      id: 'small-1',
      position: { x: 10, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 12,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    engine.addAsteroid({
      id: 'big-1',
      position: { x: 12, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 50,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 10,
      maxHealth: 10,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });

    engine.handleAsteroidHit('seed-roid', shooter.id, 'laser');
    const shard = engine.getLoot().find((drop) => drop.kind === 'shard');
    assert.ok(shard, 'shard loot');
    const blast = engine.handleLootExplode(shooter.id, shard.id);

    expect(blast.success).toBe(true);
    expect(blast.pushedAsteroidIds).toContain('small-1');
    expect(blast.pushedAsteroidIds).not.toContain('big-1');
    expect(engine.getAsteroid('small-1')?.velocity.x).toBeGreaterThan(0);
    expect(engine.getAsteroid('big-1')?.velocity.x).toBe(0);
  });

  test('blast reaches its exact edge without reading rocks beyond it', () => {
    // A rock qualifies only when `size <= SMALL_ROID_MAX` (24) and within
    // `RADIUS + size` (80 + size), so 104 bounds every possible push. Reading
    // `boost` is the loop's first act, so a distant rock that is examined at all
    // increments the counter.
    let distantReads = 0;
    const ws = new RecordingSocket();
    const shooter = engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    engine.entityManager.updateEntity('p1', { spawnProtectionTimer: 0 });
    const place = (id: string, x: number, size: number) => {
      engine.addAsteroid({
        id,
        position: { x, y: 0 },
        velocity: { x: 0, y: 0 },
        size,
        jaggedness: 0.5,
        rotation: 0,
        angularVelocity: 0,
        health: 10,
        maxHealth: 10,
        vertices: 8,
        offsets: [1, 1, 1, 1, 1, 1, 1, 1],
      });
    };
    place('seed-roid', 0, 12);
    place('edge', 92, 12); // d === 80 + 12 exactly; the predicate is `<=`
    place('past-edge', 93, 12); // one unit beyond the same reach
    // Candidates are cell-granular, so these sit several cells out: a rock
    // sharing the blast's own cells is a legitimate candidate the exact
    // predicates reject, while these must never be looked at.
    const countRead = () => {
      distantReads++;
      return undefined;
    };
    for (const [index, x] of [2000, 4000, 8000, 16_000].entries()) {
      const id = `far-${index}`;
      place(id, x, 12);
      const row = engine.getAsteroid(id);
      assert.ok(row, id);
      Object.defineProperty(row, 'boost', { get: countRead });
    }

    engine.handleAsteroidHit('seed-roid', shooter.id, 'laser');
    const shard = engine.getLoot().find((drop) => drop.kind === 'shard');
    assert.ok(shard, 'shard loot');
    distantReads = 0;
    const blast = engine.handleLootExplode(shooter.id, shard.id);

    expect(blast.success).toBe(true);
    expect(blast.pushedAsteroidIds).toContain('edge');
    expect(blast.pushedAsteroidIds).not.toContain('past-edge');
    expect(engine.getAsteroid('edge')?.velocity.x).toBeGreaterThan(0);
    expect(engine.getAsteroid('past-edge')?.velocity.x).toBe(0);
    expect(distantReads).toBe(0);
  });

  test('reset clears shards with the rest of the world', () => {
    const ws = new RecordingSocket();
    engine.addPlayer('p1', 'Pilot', ws, { x: 0, y: 0 });
    addSmallAsteroid(engine, 'roid-1', 12);
    engine.handleAsteroidHit('roid-1', 'p1', 'laser');
    expect(engine.getDiagnostics().loot).toBe(2);

    engine.resetForTesting();
    expect(engine.getLoot().filter((drop) => drop.kind !== 'points')).toHaveLength(0);
    expect(engine.getDiagnostics().loot).toBe(0);
  });
});
