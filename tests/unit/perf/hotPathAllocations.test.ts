import { expect, test } from 'vitest';
import type { AsteroidData } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { Roid, RoidBelt } from '../../../src/entities/roid/Roid';

import {
  applyAsteroidKinematics,
  createAsteroidFieldSyncScratch,
  partitionAsteroidSnapshot,
} from '../../../src/network/services/asteroidFieldSync';
import { PlayerListCache } from '../../../src/network/services/playerListCache';
import {
  fillSnapshotEntityIds,
  pruneStaleRemotePlayers,
} from '../../../src/network/services/playerPresence';

function roid(id: string, x: number, y: number): AsteroidData {
  return {
    id,
    position: { x, y },
    velocity: { x: 1, y: 0 },
    size: 20,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 10,
    maxHealth: 10,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

/**
 * Steady-state apply/loop budget: after warmup, 120 ticks must keep the same
 * player list, snapshot set, partition buffers, and entity vectors.
 */
test('120 gameState-style apply ticks reuse lists, sets, and entity vectors', () => {
  const cache = new PlayerListCache<Player>();
  const snapshotIds = new Set<string>();
  const scratch = createAsteroidFieldSyncScratch();
  const belt: { id: string }[] = [];
  const remote = new Player({
    id: 'remote',
    name: 'Castle',
    type: 'remote',
  });
  const players = new Map<string, Player>([['remote', remote]]);
  const localRoid = new Roid({ ...roid('server-asteroid-0', 1, 2), velocity: { x: 0, y: 0 } });

  const firstList = cache.allPlayers(players);
  const firstPosition = remote.ship.position;
  const firstVelocity = remote.ship.velocity;
  const firstRoidPosition = localRoid.position;
  const firstRoidVelocity = localRoid.velocity;
  const firstCreated = scratch.created;

  for (let tick = 0; tick < 120; tick++) {
    const entities = [{ id: 'remote' }];
    fillSnapshotEntityIds(entities, snapshotIds);
    remote.updateFromServer({
      position: { x: tick, y: -tick },
      velocity: { x: 0.5, y: 0.25 },
      angle: tick * 0.01,
    });
    expect(pruneStaleRemotePlayers(players, snapshotIds)).toBe(0);
    expect(cache.allPlayers(players)).toBe(firstList);

    const live = roid('server-asteroid-0', tick, -tick);
    const partitioned = partitionAsteroidSnapshot([live], belt, scratch);
    if (tick === 0) {
      expect(partitioned.created).toHaveLength(1);
      belt.push({ id: live.id });
    } else {
      expect(partitioned.updated).toHaveLength(1);
      applyAsteroidKinematics(localRoid, live, { snapPosition: true });
    }

    expect(scratch.created).toBe(firstCreated);
    expect(remote.ship.position).toBe(firstPosition);
    expect(remote.ship.velocity).toBe(firstVelocity);
    expect(localRoid.position).toBe(firstRoidPosition);
    expect(localRoid.velocity).toBe(firstRoidVelocity);
  }

  expect(firstPosition).toEqual({ x: 119, y: -119 });
  expect(firstRoidPosition).toEqual({ x: 119, y: -119 });
  expect(firstList).toHaveLength(1);
});

test('120 belt motion ticks reuse each live roid vector pair and advance their known positions', () => {
  const belt = new RoidBelt();
  belt.replaceAll([
    new Roid({ ...roid('first-moving-rock', 10, 4), velocity: { x: 1, y: -0.5 } }),
    new Roid({ ...roid('second-moving-rock', -20, 8), velocity: { x: -1, y: 0.25 } }),
  ]);
  const positions = belt.getRoids().map((body) => body.position);
  const velocities = belt.getRoids().map((body) => body.velocity);
  for (let tick = 0; tick < 120; tick++) {
    belt.moveRoids();
  }
  expect(belt.getRoids()[0]?.position).toBe(positions[0]);
  expect(belt.getRoids()[0]?.velocity).toBe(velocities[0]);
  expect(belt.getRoids()[1]?.position).toBe(positions[1]);
  expect(belt.getRoids()[1]?.velocity).toBe(velocities[1]);
  expect(belt.getRoids()[0]?.position).toEqual({ x: 130, y: -56 });
  expect(belt.getRoids()[1]?.position).toEqual({ x: -140, y: 38 });
});
