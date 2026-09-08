import { expect, test } from 'vitest';
import type { AsteroidData } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
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
import { stepAsteroidMotionInto } from '../../../src/physics/asteroidMotion';

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
  const seen = new Set<string>();
  const remote = new Player({
    id: 'remote',
    name: 'Castle',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  const players = new Map<string, Player>([['remote', remote]]);
  const localRoid = {
    position: { x: 1, y: 2 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    health: 10,
    maxHealth: 10,
    r: 20,
  };

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
    const partitioned = partitionAsteroidSnapshot([live], seen, scratch);
    if (tick === 0) {
      expect(partitioned.created).toHaveLength(1);
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

test('120 belt motion ticks reuse each roid vector pair', () => {
  const roids = [
    { position: { x: 10, y: 4 }, velocity: { x: 1, y: -0.5 } },
    { position: { x: -20, y: 8 }, velocity: { x: -1, y: 0.25 } },
  ];
  const positions = roids.map((roid) => roid.position);
  const velocities = roids.map((roid) => roid.velocity);

  for (let tick = 0; tick < 120; tick++) {
    for (const body of roids) {
      stepAsteroidMotionInto(body.position, body.velocity, 1, body.position, body.velocity);
    }
  }

  expect(roids[0]?.position).toBe(positions[0]);
  expect(roids[0]?.velocity).toBe(velocities[0]);
  expect(roids[1]?.position).toBe(positions[1]);
  expect(roids[1]?.velocity).toBe(velocities[1]);
  expect(roids[0]?.position.x).toBeGreaterThan(10);
});
