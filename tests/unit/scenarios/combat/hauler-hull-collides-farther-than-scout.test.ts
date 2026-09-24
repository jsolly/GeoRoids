import { expect, test, vi } from 'vitest';
import { CollisionAuthority } from '../../../../server/core/CollisionAuthority';
import { GameEngine } from '../../../../server/core/GameEngine';
import type { AsteroidData } from '../../../../shared-types';
import { hullRadiusForKit } from '../../../../src/entities/ship/shipKits';
import { RecordingSocket } from '../../../support/recordingSocket';

vi.mock('../../../../setup/serverLogger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function rock(id: string, x: number, size: number): AsteroidData {
  return {
    id,
    position: { x, y: 0 },
    velocity: { x: 0, y: 0 },
    size,
    offsets: [1, 1, 1, 1],
    vertices: 4,
    jaggedness: 0,
    health: 25,
    maxHealth: 25,
    rotation: 0,
    angularVelocity: 0,
  };
}

test('a Hauler collides with a rock that a same-mass Scout still clears', () => {
  const engine = new GameEngine(11);
  try {
    const scout = engine.addPlayer('scout', 'Scout', new RecordingSocket(), { x: 0, y: 0 });
    const hauler = engine.addPlayer(
      'hauler',
      'Barge',
      new RecordingSocket(),
      { x: 0, y: 0 },
      'hauler'
    );
    engine.updatePlayer(scout.id, { position: { x: 0, y: 0 }, spawnProtectionTimer: 0 });
    engine.updatePlayer(hauler.id, { position: { x: 0, y: 0 }, spawnProtectionTimer: 0 });

    const rockSize = 10;
    const gapPastScout = hullRadiusForKit('scout') + rockSize + 2;
    const candidate = rock('near-miss', gapPastScout, rockSize);
    const collisions = new CollisionAuthority();

    expect(collisions.collectShipAsteroidHits([scout], [candidate])).toEqual([]);
    expect(collisions.collectShipAsteroidHits([hauler], [candidate])).toEqual([
      { shipId: hauler.id, asteroidId: candidate.id },
    ]);
  } finally {
    engine.stopGameLoop();
  }
});
