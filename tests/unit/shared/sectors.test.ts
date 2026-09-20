import { describe, expect, test } from 'vitest';
import { ExplorationMap } from '../../../shared/exploration';
import {
  chooseOpenSectorSpawn,
  containBodyOutOfCompletedSectors,
  findSectorWallImpact,
  isInsideCompletedSector,
  isSectorExplorationComplete,
  readCompletedSectorIds,
  sectorBounds,
  shipOverlapsCompletedSector,
} from '../../../shared/sectors';
import { WORLD } from '../../../shared/world';

describe('open-world sector helpers', () => {
  test('sector bounds cover a 2,000-unit square', () => {
    expect(sectorBounds(2, -1)).toEqual({
      x: 2,
      y: -1,
      id: '2,-1',
      minX: 4_000,
      minY: -2_000,
      maxX: 6_000,
      maxY: 0,
    });
  });

  test('a sector is exploration-complete only after every in-world cell is revealed', () => {
    const exploration = new ExplorationMap();
    expect(isSectorExplorationComplete(exploration.snapshot(), 2, 0)).toBe(false);
    exploration.reveal({ x: 5_000, y: 1_000 }, WORLD.sectorSize);
    expect(isSectorExplorationComplete(exploration.snapshot(), 2, 0)).toBe(true);
  });

  test('spawn keeps a requested pose that is already in an open sector', () => {
    const requested = { x: 120, y: -40 };
    const spawn = chooseOpenSectorSpawn({
      completed: new Set(['2,0']),
      previous: requested,
      random: () => 0.25,
    });
    expect(spawn).toEqual(requested);
    expect(spawn).not.toBe(requested);
  });

  test('spawn relocates out of a completed sector instead of clustering there', () => {
    const spawn = chooseOpenSectorSpawn({
      completed: new Set(['2,0']),
      previous: { x: 5_000, y: 1_000 },
      random: () => 0.25,
    });
    expect(isInsideCompletedSector(spawn, new Set(['2,0']))).toBe(false);
    expect(Math.hypot(spawn.x, spawn.y)).toBeLessThanOrEqual(WORLD.radius);
  });

  test('a laser segment reports the first completed-sector wall it crosses', () => {
    const impact = findSectorWallImpact(
      { x: 3_900, y: 1_000 },
      { x: 4_200, y: 1_000 },
      new Set(['2,0'])
    );
    expect(impact).not.toBeNull();
    expect(impact?.point).toEqual({ x: 4_000, y: 1_000 });
    expect(impact?.normal).toEqual({ x: -1, y: 0 });
    expect(impact?.distance).toBeCloseTo(100);
  });

  test('asteroids bounce out of completed sectors', () => {
    const body = {
      position: { x: 4_010, y: 1_000 },
      velocity: { x: 4, y: 0 },
    };
    expect(containBodyOutOfCompletedSectors(body, new Set(['2,0']))).toBe(true);
    expect(isInsideCompletedSector(body.position, new Set(['2,0']))).toBe(false);
    expect(body.velocity.x).toBeLessThan(0);
  });

  test('an asteroid near the far wall leaves through that wall instead of teleporting back', () => {
    const body = {
      position: { x: 5_990, y: 1_000 },
      velocity: { x: 4, y: 0 },
    };
    expect(containBodyOutOfCompletedSectors(body, new Set(['2,0']))).toBe(true);
    expect(body.position.x).toBeGreaterThan(6_000);
    expect(body.velocity.x).toBeGreaterThan(0);
  });

  test('a ship flying east is placed ahead of a completed sector instead of behind it', () => {
    const body = {
      position: { x: 5_000, y: 1_000 },
      velocity: { x: 4, y: 0 },
    };
    expect(
      containBodyOutOfCompletedSectors(body, new Set(['2,0']), {
        radius: 15,
        bias: { x: 4, y: 0 },
      })
    ).toBe(true);
    expect(body.position.x).toBeGreaterThan(6_000);
    expect(shipOverlapsCompletedSector(body.position, 15, new Set(['2,0']))).toBe(false);
    expect(body.velocity.x).toBeGreaterThan(0);
  });

  test('predicted flight that nicks a completed wall is pushed back out', () => {
    const body = {
      position: { x: 3_990, y: 1_000 },
      velocity: { x: 4, y: 0 },
    };
    expect(containBodyOutOfCompletedSectors(body, new Set(['2,0']), { radius: 15 })).toBe(true);
    expect(body.position.x).toBeLessThan(4_000);
    expect(shipOverlapsCompletedSector(body.position, 15, new Set(['2,0']))).toBe(false);
    expect(body.velocity.x).toBeLessThan(0);
  });

  test('a hull that already crossed the east grid is pushed farther out, not back in', () => {
    const body = {
      position: { x: 6_010, y: 1_000 },
      velocity: { x: 4, y: 0 },
    };
    expect(containBodyOutOfCompletedSectors(body, new Set(['2,0']), { radius: 15 })).toBe(true);
    expect(body.position.x).toBeGreaterThan(6_010);
    expect(shipOverlapsCompletedSector(body.position, 15, new Set(['2,0']))).toBe(false);
    expect(body.velocity.x).toBeGreaterThan(0);
  });

  test('a ship overlapping a completed wall is treated as inside the closed sector', () => {
    expect(shipOverlapsCompletedSector({ x: 3_990, y: 1_000 }, 15, new Set(['2,0']))).toBe(true);
    expect(shipOverlapsCompletedSector({ x: 3_900, y: 1_000 }, 15, new Set(['2,0']))).toBe(false);
  });

  test('invalid saved completed-sector payloads fail closed', () => {
    expect(() => readCompletedSectorIds(null)).toThrow('Saved completed sectors are invalid');
    expect(() => readCompletedSectorIds('2,0')).toThrow('Saved completed sectors are invalid');
    expect(() => readCompletedSectorIds(['2,0', '2,0'])).toThrow(
      'Saved completed sectors are invalid'
    );
    expect(() => readCompletedSectorIds(['not-a-sector'])).toThrow(
      'Saved completed sectors are invalid'
    );
  });

  test('spawn throws when every world-overlapping sector is complete', () => {
    const span = Math.ceil(WORLD.radius / WORLD.sectorSize) + 1;
    const completed = new Set<string>();
    for (let y = -span; y <= span; y++) {
      for (let x = -span; x <= span; x++) {
        completed.add(`${x},${y}`);
      }
    }
    expect(() =>
      chooseOpenSectorSpawn({
        completed,
        random: () => 0.5,
      })
    ).toThrow('No open sector remains for spawn');
  });
});
