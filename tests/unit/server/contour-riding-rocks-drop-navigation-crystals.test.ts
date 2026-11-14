/* @vitest-environment node */
import { expect, test } from 'vitest';
import { CONTOUR_ASTEROID_SPEED, stepContourAsteroid } from '../../../shared/contourAsteroid';
import { contourLockDistance } from '../../../shared/contourLock';
import { sampleGradient, sampleHeight } from '../../../shared/heightfield';
import { validateAsteroidDto } from '../../../shared/snapshotDto';
import { TERRAIN } from '../../../shared/terrainConfig';
import { getTerrainField } from '../../../shared/terrainField';
import type { AsteroidData } from '../../../shared-types';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();
function rider(): AsteroidData {
  const position = { x: 2250, y: 0 };
  const field = getTerrainField();
  const height =
    Math.round(sampleHeight(field, position.x, position.y) / TERRAIN.CONTOUR_INTERVAL) *
    TERRAIN.CONTOUR_INTERVAL;
  for (let i = 0; i < 8; i++) {
    const gradient = sampleGradient(field, position.x, position.y, 0.25);
    const correction =
      (height - sampleHeight(field, position.x, position.y)) / (gradient.x ** 2 + gradient.y ** 2);
    position.x += gradient.x * correction;
    position.y += gradient.y * correction;
  }
  return {
    id: 'rail-rock',
    position,
    velocity: { x: 0, y: 0 },
    size: 20,
    health: 40,
    maxHealth: 40,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    material: 'ice',
    contourRider: { height, direction: 1 },
  };
}

test('the shared predicted step follows the curved rail at limited speed for ten seconds', () => {
  const world = new GameServerWorld();
  try {
    const rock = rider();
    const restored: AsteroidData = JSON.parse(JSON.stringify(rock));
    validateAsteroidDto(restored);
    const start = { ...rock.position };
    for (let i = 0; i < 600; i++) {
      expect(stepContourAsteroid(rock)).toBe(true);
      expect(stepContourAsteroid(restored)).toBe(true);
      expect(rock.contourRider).toBeTruthy();
      if (!rock.contourRider) {
        throw new Error('Rail lost');
      }
      expect(contourLockDistance(rock.position, rock.contourRider)).toBeLessThan(1);
      expect(Math.hypot(rock.velocity.x, rock.velocity.y)).toBeCloseTo(CONTOUR_ASTEROID_SPEED);
    }
    expect(rock.position).toEqual(restored.position);
    expect(Math.hypot(rock.position.x - start.x, rock.position.y - start.y)).toBeGreaterThan(100);
  } finally {
    world.dispose();
  }
});

test.each(['laser', 'collision'] as const)(
  'a %s break grants navigation salvage only for a mining laser',
  (cause) => {
    const world = new GameServerWorld();
    try {
      const pilot = world.join('Miner', { x: 0, y: 0 });
      world.clearAsteroids();
      const rock = rider();
      world.engine.asteroidLifecycle.insert(rock);
      const result = world.engine.handleAsteroidHit(rock.id, pilot.id, cause, 1000);
      expect(result.outcome).toBe('destroyed');
      expect(world.engine.getLoot().filter((drop) => drop.salvage === 'crystal')).toHaveLength(
        cause === 'laser' ? 1 : 0
      );
    } finally {
      world.dispose();
    }
  }
);
