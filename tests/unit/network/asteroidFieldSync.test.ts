import { expect, test } from 'vitest';
import type { AsteroidData, AsteroidDestroyEvent } from '../../../shared-types';
import type { AsteroidKinematicTarget } from '../../../src/network/services/asteroidFieldSync';
import {
  applyAsteroidFieldPartition,
  applyAsteroidKinematics,
  applyAsteroidRowToBelt,
  asteroidHasSpawnPose,
  asteroidKinematicUpdates,
  bindAsteroidFieldApply,
  createAsteroidFieldSyncScratch,
  notifyAsteroidDestroyed,
  partitionAsteroidSnapshot,
  shouldPreserveSeenAsteroidsOnJoin,
  shouldSnapAsteroidPose,
  unbindAsteroidFieldApply,
  writeAsteroidKinematicUpdates,
} from '../../../src/network/services/asteroidFieldSync';

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

function localRoid(x: number, y: number): AsteroidKinematicTarget {
  return {
    position: { x, y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    health: 10,
    maxHealth: 10,
    r: 20,
  };
}

test('first snapshot creates every asteroid and records the ids', () => {
  const seen = new Set<string>();
  const { created, updated, removed } = partitionAsteroidSnapshot(
    [roid('server-asteroid-0', 1, 2), roid('server-asteroid-1', 3, 4)],
    seen
  );

  expect(created.map((asteroid) => asteroid.id)).toEqual([
    'server-asteroid-0',
    'server-asteroid-1',
  ]);
  expect(updated).toEqual([]);
  expect(removed).toEqual([]);
  expect(seen.size).toBe(2);
});

test('a later snapshot updates known asteroids so a late joiner can share the live field', () => {
  const seen = new Set(['server-asteroid-0']);
  const live = roid('server-asteroid-0', 80, -12);
  const fresh = roid('server-asteroid-2', 0, 0);
  const { created, updated, removed } = partitionAsteroidSnapshot([live, fresh], seen);
  expect(removed).toEqual([]);

  expect(created.map((asteroid) => asteroid.id)).toEqual(['server-asteroid-2']);
  expect(updated).toEqual([live]);
  expect(asteroidKinematicUpdates(live).position).toEqual({ x: 80, y: -12 });
  expect(seen.has('server-asteroid-2')).toBe(true);
});

test('a duplicate create still writes the live pose onto the existing roid', () => {
  const local = localRoid(1, 2);
  applyAsteroidKinematics(local, roid('server-asteroid-0', 80, -12), { snapPosition: true });
  expect(local.position).toEqual({ x: 80, y: -12 });
  expect(local.velocity).toEqual({ x: 1, y: 0 });
});

test('an empty snapshot does not wipe seen ids so a remaining tab keeps the belt', () => {
  const seen = new Set(['server-asteroid-0', 'server-asteroid-1']);
  const { created, updated, removed } = partitionAsteroidSnapshot([], seen);
  expect(created).toEqual([]);
  expect(updated).toEqual([]);
  expect(removed).toEqual([]);
  expect(seen.size).toBe(2);
});

test('a later non-empty snapshot prunes ids the server no longer has', () => {
  const seen = new Set(['server-asteroid-0', 'gone']);
  const { removed } = partitionAsteroidSnapshot([roid('server-asteroid-0', 4, 5)], seen);
  expect(removed).toEqual(['gone']);
  expect(seen.has('gone')).toBe(false);
  expect(seen.has('server-asteroid-0')).toBe(true);
});

test('applying a 10k live pose contains it inside the shared belt', () => {
  const local = localRoid(1, 2);
  applyAsteroidKinematics(local, roid('server-asteroid-0', 10000, 0));
  expect(local.position.x).toBeGreaterThan(0);
  expect(Math.hypot(local.position.x, local.position.y)).toBeLessThan(1300);
});

test('small pose error keeps the interpolated position so the field does not hitch', () => {
  const local = {
    position: { x: 10, y: 10 },
    velocity: { x: 1, y: 0 },
    angle: 0,
    angularVelocity: 0,
    health: 10,
    maxHealth: 10,
    r: 20,
  };
  applyAsteroidKinematics(local, {
    position: { x: 14, y: 10 },
    velocity: { x: 2, y: 0 },
  });
  expect(shouldSnapAsteroidPose({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(false);
  expect(local.position).toEqual({ x: 10, y: 10 });
  expect(local.velocity).toEqual({ x: 2, y: 0 });
});

test('a large pose error snaps so a late joiner shares the live field', () => {
  const local = localRoid(1, 2);
  applyAsteroidKinematics(local, roid('server-asteroid-0', 80, -12));
  expect(local.position).toEqual({ x: 80, y: -12 });
});

test('an escaped local pose contains even when the server echo is also far', () => {
  const local = localRoid(10000, 40);
  applyAsteroidKinematics(local, {
    position: { x: 10005, y: 40 },
    velocity: { x: 1, y: 0 },
  });
  expect(shouldSnapAsteroidPose({ x: 10000, y: 40 }, { x: 10005, y: 40 })).toBe(false);
  expect(Math.hypot(local.position.x, local.position.y)).toBeLessThan(1300);
  expect(local.position.x).toBeGreaterThan(0);
});

test('a lean first-seen row does not mark seen so a later full row can still create', () => {
  const seen = new Set<string>();
  const lean = {
    id: 'server-asteroid-0',
    position: { x: 80, y: -12 },
    rotation: 1.2,
  } as AsteroidData;
  const first = partitionAsteroidSnapshot([lean], seen);
  expect(first.created).toEqual([]);
  expect(first.updated).toEqual([]);
  expect(seen.size).toBe(0);
  expect(asteroidHasSpawnPose(lean)).toBe(false);

  const full = roid('server-asteroid-0', 80, -12);
  const later = partitionAsteroidSnapshot([full], seen);
  expect(later.created.map((asteroid) => asteroid.id)).toEqual(['server-asteroid-0']);
  expect(seen.has('server-asteroid-0')).toBe(true);
});

test('a shaped update for a missing belt id creates instead of no-op', () => {
  const belt = new Map<string, ReturnType<typeof localRoid>>();
  const created: string[] = [];
  const action = applyAsteroidRowToBelt(
    (id) => belt.get(id),
    'server-asteroid-0',
    roid('server-asteroid-0', 80, -12),
    (asteroid) => {
      created.push(asteroid.id);
      belt.set(asteroid.id, localRoid(asteroid.position.x, asteroid.position.y));
    }
  );
  expect(action).toBe('created');
  expect(created).toEqual(['server-asteroid-0']);
  expect(belt.size).toBe(1);
});

test('lean kinematics without size do not invent a belt rock', () => {
  const action = applyAsteroidRowToBelt(
    () => undefined,
    'server-asteroid-0',
    { position: { x: 80, y: -12 }, rotation: 1.2 },
    () => {
      throw new Error('must not create from pose-only lean');
    }
  );
  expect(action).toBe('skipped');
});

test('an unknown material in a snapshot is rejected before it can reach the belt', () => {
  const seen = new Set<string>();
  const invalid = {
    ...roid('invalid-material', 80, -12),
    material: 'plasma',
  } as unknown as AsteroidData;

  const result = partitionAsteroidSnapshot([invalid], seen);

  expect(result.created).toEqual([]);
  expect(result.updated).toEqual([]);
  expect(result.removed).toEqual([]);
  expect(seen.has(invalid.id)).toBe(false);
  expect(asteroidHasSpawnPose(invalid)).toBe(false);
});

test('an invalid material update is ignored without changing an existing local material', () => {
  const local = { ...localRoid(1, 2), material: 'ice' as const };

  applyAsteroidKinematics(local, {
    material: 'plasma',
  } as unknown as Partial<AsteroidData>);

  expect(local.material).toBe('ice');
});

test('snapshot reconciliation removes stale rows without looking like an explicit destroy', () => {
  const reconciled: string[] = [];
  const destroyed: AsteroidDestroyEvent[] = [];
  bindAsteroidFieldApply({
    onCreated: () => {},
    onUpdated: () => {},
    onDestroyed: (event) => destroyed.push(event),
    onReconciled: (asteroidId) => reconciled.push(asteroidId),
  });

  try {
    applyAsteroidFieldPartition({ created: [], updated: [], removed: ['replaced-row'] });
    notifyAsteroidDestroyed({ asteroidId: 'authoritative-destroy', collabSplit: true });
  } finally {
    unbindAsteroidFieldApply();
  }

  expect(reconciled).toEqual(['replaced-row']);
  expect(destroyed).toEqual([{ asteroidId: 'authoritative-destroy', collabSplit: true }]);
});

test('kinematic updates omit undefined fields so a lean row cannot wipe pose', () => {
  expect(asteroidKinematicUpdates({ id: 'server-asteroid-0', position: { x: 3, y: 4 } })).toEqual({
    position: { x: 3, y: 4 },
  });
});

test('writeAsteroidKinematicUpdates reuses the caller envelope and drops stale keys', () => {
  const into: Partial<AsteroidData> = { health: 9, size: 40 };
  const same = writeAsteroidKinematicUpdates({ position: { x: 3, y: 4 } }, into);
  expect(same).toBe(into);
  expect(into).toEqual({ position: { x: 3, y: 4 } });
});

test('collab flag copies onto the local rock so both pilots can chip it', () => {
  const local = { ...localRoid(1, 2), isCollabTarget: false };
  applyAsteroidKinematics(local, { ...roid('server-asteroid-0', 10, 10), isCollabTarget: true });
  expect(local.isCollabTarget).toBe(true);
});

test('reflection and spin metadata reaches the local rock for live cues and previews', () => {
  const local = localRoid(1, 2);
  const reflective = {
    ...roid('reflective-0', 10, 10),
    phenomenon: { kind: 'reflective' as const, clusterId: 'cluster-0', energy: 2, maxEnergy: 6 },
    spinClass: 'charged' as const,
  };

  applyAsteroidKinematics(local, reflective);

  expect(local.phenomenon).toEqual(reflective.phenomenon);
  expect(local.spinClass).toBe('charged');
});

test('partition scratch arrays and snapshot set stay the same identity', () => {
  const seen = new Set<string>();
  const scratch = createAsteroidFieldSyncScratch();
  const first = partitionAsteroidSnapshot([roid('a', 1, 2)], seen, scratch);
  expect(first.created).toBe(scratch.created);
  expect(first.updated).toBe(scratch.updated);
  expect(first.removed).toBe(scratch.removed);

  const second = partitionAsteroidSnapshot([roid('a', 3, 4), roid('b', 0, 0)], seen, scratch);
  expect(second.created).toBe(scratch.created);
  expect(second.updated).toBe(scratch.updated);
  expect(second.created.map((asteroid) => asteroid.id)).toEqual(['b']);
  expect(second.updated.map((asteroid) => asteroid.id)).toEqual(['a']);
});

test('applyAsteroidKinematics writes into the existing roid vectors', () => {
  const local = localRoid(1, 2);
  const position = local.position;
  const velocity = local.velocity;
  applyAsteroidKinematics(local, roid('server-asteroid-0', 80, -12));
  expect(local.position).toBe(position);
  expect(local.velocity).toBe(velocity);
  expect(position).toEqual({ x: 80, y: -12 });
  expect(velocity).toEqual({ x: 1, y: 0 });
});

test('a warm rejoin keeps seen asteroid ids so the next snapshot updates in place', () => {
  expect(shouldPreserveSeenAsteroidsOnJoin(0)).toBe(false);
  expect(shouldPreserveSeenAsteroidsOnJoin(11)).toBe(true);
});
