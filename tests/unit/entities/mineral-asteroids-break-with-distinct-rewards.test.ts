import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { RNGService } from '../../../server/core/RNGService';
import { ASTEROID_MATERIALS, MATERIAL_OUTLINES } from '../../../shared/asteroidMaterials';
import type { AsteroidData, AsteroidMaterial } from '../../../shared-types';
import { DAMAGE, ROID } from '../../../src/constants';
import { serializeAsteroidMaterialSvg } from '../../../src/entities/roid/materialArt';
import { Roid } from '../../../src/entities/roid/Roid';
import { applyAsteroidKinematics } from '../../../src/network/services/asteroidFieldSync';

function mineral(material: AsteroidMaterial, size = 36): AsteroidData {
  const offsets = [...MATERIAL_OUTLINES[material]];
  return {
    id: material,
    material,
    position: { x: 400, y: 300 },
    velocity: { x: 1, y: 0 },
    size,
    jaggedness: 0.3,
    rotation: 0,
    angularVelocity: 0,
    health: DAMAGE.LASER_HIT * (material === 'metal' ? 3 : 1),
    maxHealth: DAMAGE.LASER_HIT * (material === 'metal' ? 3 : 1),
    vertices: offsets.length,
    offsets,
  };
}

describe('mineral asteroids break with distinct rewards', () => {
  test('a shared field supplies all three readable contours and syncs them to a joining pilot', () => {
    const rocks = new AsteroidManager(new RNGService(42)).createAsteroids(6);
    expect(new Set(rocks.map((rock) => rock.material))).toEqual(
      new Set(['ice', 'metal', 'rubble'])
    );
    expect(new Set(rocks.map((rock) => rock.size)).size).toBeGreaterThan(1);
    expect(rocks.every((rock) => rock.size >= 18 && rock.size <= 48)).toBe(true);
    expect(rocks.find((rock) => rock.isCollabTarget)?.size).toBeGreaterThanOrEqual(
      ROID.COLLAB_SPLIT_MIN_SIZE
    );
    for (const rock of rocks) {
      const local = new Roid({ x: 0, y: 0 }, 1, rock.id);
      applyAsteroidKinematics(local, rock);
      expect(local.material).toBe(rock.material);
      expect(local.maxHealth).toBe(rock.maxHealth);
      assert.ok(rock.material);
      expect(rock.vertices).toBe(MATERIAL_OUTLINES[rock.material].length);
      expect(rock.offsets.every(Number.isFinite)).toBe(true);
    }
  });

  test('metal takes three hits, survives waiting, and drops three times the ice shard mass', () => {
    const engine = new GameEngine(42);
    engine.addAsteroid(mineral('ice'));
    engine.addAsteroid(mineral('metal'));
    engine.handleAsteroidHit('ice', 'pilot', 'laser', 0);
    expect(engine.handleAsteroidHit('metal', 'pilot', 'laser', 100).outcome).toBe('tagged');
    engine.flushExpiredCollabHits(10000);
    expect(engine.getAsteroid('metal')?.health).toBe(DAMAGE.LASER_HIT * 2);
    expect(engine.handleAsteroidHit('metal', 'pilot', 'laser', 10100).outcome).toBe('tagged');
    expect(engine.handleAsteroidHit('metal', 'pilot', 'laser', 10300).outcome).toBe('destroyed');
    const masses = engine
      .getLoot()
      .filter((drop) => drop.kind === 'shard')
      .map((drop) => drop.mass);
    expect(masses).toEqual([0.25, 0.75]);
    expect(engine.handleAsteroidHit('metal', 'pilot').outcome).toBe('missing');
    expect(engine.getLoot().filter((drop) => drop.kind === 'shard')).toHaveLength(2);
  });

  test('ice breaks cleanly while rubble yields three uneven fragments that cannot multiply indefinitely', () => {
    const manager = new AsteroidManager(new RNGService(42));
    manager.addAsteroid(mineral('ice'));
    manager.addAsteroid(mineral('rubble'));
    expect(manager.registerLaserHit('ice', 'pilot').newAsteroids).toHaveLength(0);
    const broken = manager.registerLaserHit('rubble', 'pilot');
    expect(broken.newAsteroids).toHaveLength(3);
    expect(new Set(broken.newAsteroids.map((rock) => rock.size)).size).toBe(3);
    expect(
      new Set(broken.newAsteroids.map((rock) => `${rock.velocity.x}:${rock.velocity.y}`)).size
    ).toBe(3);
    for (const fragment of broken.newAsteroids) {
      expect(fragment.material).toBe('rubble');
      expect(fragment.size).toBeLessThan(20);
      expect(manager.registerLaserHit(fragment.id, 'pilot').newAsteroids).toHaveLength(0);
    }
    expect(manager.getAsteroidCount()).toBe(0);
  });

  test('rubble fragmentation respects the world cap and ship rams create no fragments', () => {
    const manager = new AsteroidManager(new RNGService(42));
    for (let i = 0; i < 198; i++) {
      manager.addAsteroid({ ...mineral('ice'), id: `ice-${i}` });
    }
    manager.addAsteroid(mineral('rubble'));
    expect(manager.registerLaserHit('rubble', 'pilot').newAsteroids).toHaveLength(0);
    manager.addAsteroid(mineral('rubble'));
    expect(manager.destroyFromCollision('rubble').newAsteroids).toHaveLength(0);
  });

  test('one pilot breaking rubble creates fragments without a cooperative shockwave', () => {
    const engine = new GameEngine(42);
    engine.addAsteroid(mineral('rubble'));
    const result = engine.applyLaserAsteroidHit('rubble', 'pilot', { x: 400, y: 300 });
    expect(result.applied).toBe(true);
    expect(result.newAsteroids).toHaveLength(3);
    expect(result.split).toBe(false);
  });

  test('mineral SVG assets match the contours and facets used by the Canvas renderer', () => {
    for (const material of ASTEROID_MATERIALS) {
      const onDisk = readFileSync(
        resolve(process.cwd(), 'georoids-art/personality-roids', `${material}.svg`),
        'utf8'
      );
      expect(onDisk).toBe(serializeAsteroidMaterialSvg(material));
      expect(onDisk).toContain('fill="none"');
    }
  });
});
