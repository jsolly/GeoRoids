import { describe, expect, test } from 'vitest';
import { AsteroidManager } from '../../../server/core/AsteroidManager';
import { RNGService } from '../../../server/core/RNGService';
import { partitionAsteroidSnapshot } from '../../../src/network/services/asteroidFieldSync';
import { getAsteroidFieldRadius, stepAsteroidMotion } from '../../../src/physics/asteroidMotion';
import {
  PLAYFIELD_CLOSE_SCALE,
  countRocksOnCanvas,
  drawingOffsets,
  playfieldZoom,
  radarBeltVisibleOnPlayfield,
} from '../../../src/rendering/playfieldCamera';

const SMALL = { width: 800, height: 600 };
const HD = { width: 1920, height: 1080 };

/** Live www poses captured after #444 (c29e9f9): humans outside / on the rim of the 1200 belt. */
const TAB_A_IN_BELT = { x: 0, y: 0 };
const TAB_B_OUTSIDE = { x: -1392, y: -487 };
const RIM_1080P_MISS = { x: 326, y: -1098 };

function beltAfterTicks(seed: number, count: number, ticks: number) {
  const manager = new AsteroidManager(new RNGService(seed));
  manager.createAsteroids(count);
  for (let i = 0; i < ticks; i++) {
    manager.updateMotion();
  }
  return manager.getAllAsteroids().map((asteroid) => ({
    id: asteroid.id,
    position: asteroid.position,
    r: asteroid.size,
    offsets: asteroid.offsets,
  }));
}

describe('close playfield camera and wide minimap', () => {
  test('keeps one close scale at every camera pose and viewport', () => {
    const field = beltAfterTicks(11, 20, 70 * 60);
    for (const ship of [TAB_A_IN_BELT, TAB_B_OUTSIDE, RIM_1080P_MISS, { x: 2000, y: 1500 }]) {
      expect(playfieldZoom(field, ship, SMALL)).toBe(PLAYFIELD_CLOSE_SCALE);
      expect(playfieldZoom(field, ship, HD)).toBe(PLAYFIELD_CLOSE_SCALE);
    }
  });

  test('close scale keeps nearby rocks legible while the minimap remains the wide view', () => {
    const field = beltAfterTicks(11, 20, 70 * 60);
    expect(field.length).toBeGreaterThan(0);
    expect(countRocksOnCanvas(field, TAB_A_IN_BELT, SMALL, PLAYFIELD_CLOSE_SCALE)).toBeGreaterThan(
      0
    );
    expect(countRocksOnCanvas(field, TAB_B_OUTSIDE, SMALL, PLAYFIELD_CLOSE_SCALE)).toBe(0);
    expect(radarBeltVisibleOnPlayfield(field, TAB_A_IN_BELT, SMALL)).toBe(true);
    expect(radarBeltVisibleOnPlayfield(field, TAB_B_OUTSIDE, SMALL)).toBe(false);
  });

  test('a one-to-one rock reappears through ordinary close-camera motion', () => {
    let position = { x: 900, y: 0 };
    const velocity = { x: -50 / 60, y: 0 };
    const ship = { x: 0, y: 0 };
    expect(countRocksOnCanvas([{ position }], ship, SMALL, PLAYFIELD_CLOSE_SCALE)).toBe(0);
    for (let i = 0; i < 15 * 60; i++) {
      position = stepAsteroidMotion(position, velocity).position;
    }
    expect(countRocksOnCanvas([{ position }], ship, SMALL, PLAYFIELD_CLOSE_SCALE)).toBe(1);
  });

  test('same server snapshot produces identical belt ids on two close-camera clients', () => {
    const field = beltAfterTicks(3, 12, 0);
    const payload = field.map((rock) => ({
      id: rock.id,
      position: rock.position,
      velocity: { x: 0, y: 0 },
      size: rock.r,
      jaggedness: 0.5,
      rotation: 0,
      angularVelocity: 0,
      health: 100,
      maxHealth: 100,
      vertices: 8,
      offsets: rock.offsets,
    }));
    const a = partitionAsteroidSnapshot(payload, new Set());
    const b = partitionAsteroidSnapshot(payload, new Set());
    expect(a.created.map((rock) => rock.id)).toEqual(b.created.map((rock) => rock.id));
    expect(a.removed).toEqual([]);
    expect(b.removed).toEqual([]);
  });

  test('empty offsets still have a stroke path', () => {
    expect(drawingOffsets([])).toEqual([1]);
    expect(drawingOffsets([1.1, 0.9])).toEqual([1.1, 0.9]);
  });

  test('drawingOffsets reuses the input array and a shared empty fallback', () => {
    const offsets = [1.1, 0.9];
    expect(drawingOffsets(offsets)).toBe(offsets);
    expect(drawingOffsets([])).toBe(drawingOffsets([]));
  });

  test('fixed scale keeps the canonical asteroid field within the arena', () => {
    const field = beltAfterTicks(21, 20, 70 * 60);
    expect(field.length).toBeGreaterThan(0);
    for (const rock of field) {
      expect(Math.hypot(rock.position.x, rock.position.y)).toBeLessThanOrEqual(
        getAsteroidFieldRadius() + 1
      );
    }
  });
});
