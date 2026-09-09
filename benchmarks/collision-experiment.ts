import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type CombatCircle,
  circlesOverlap,
  findShipAsteroidOverlaps,
  findShipShipPairs,
} from '../shared/combat';
import { type Measurement, validateMeasurement } from './results';

// Experiment only. Preserve source-array priority, including first asteroid per ship.
const CELL = 128;
function cells(circle: Pick<CombatCircle, 'position' | 'radius'>): string[] {
  const keys: string[] = [];
  for (
    let x = Math.floor((circle.position.x - circle.radius) / CELL);
    x <= Math.floor((circle.position.x + circle.radius) / CELL);
    x++
  ) {
    for (
      let y = Math.floor((circle.position.y - circle.radius) / CELL);
      y <= Math.floor((circle.position.y + circle.radius) / CELL);
      y++
    ) {
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}
function grid(items: CombatCircle[]) {
  const index = new Map<string, number[]>();
  for (const [i, item] of items.entries()) {
    for (const key of cells(item)) {
      const rows = index.get(key);
      if (rows) {
        rows.push(i);
      } else {
        index.set(key, [i]);
      }
    }
  }
  return (item: CombatCircle): number[] =>
    [...new Set(cells(item).flatMap((key) => index.get(key) ?? []))].sort((a, b) => a - b);
}
function indexed(ships: CombatCircle[], rocks: CombatCircle[]) {
  const queryRocks = grid(rocks);
  const queryShips = grid(ships);
  const hits: ReturnType<typeof findShipAsteroidOverlaps> = [];
  const pairs: ReturnType<typeof findShipShipPairs> = [];
  let candidates = 0;
  for (const [i, ship] of ships.entries()) {
    if (ship.immune) {
      continue;
    }
    for (const j of queryRocks(ship)) {
      const rock = rocks[j];
      assert(rock);
      candidates++;
      if (circlesOverlap(ship.position, ship.radius, rock.position, rock.radius)) {
        hits.push({ shipId: ship.id, asteroidId: rock.id });
        break;
      }
    }
    for (const j of queryShips(ship)) {
      if (j <= i) {
        continue;
      }
      const other = ships[j];
      assert(other);
      if (other.immune) {
        continue;
      }
      candidates++;
      if (circlesOverlap(ship.position, ship.radius, other.position, other.radius)) {
        pairs.push({ a: ship.id, b: other.id });
      }
    }
  }
  return { hits, pairs, candidates };
}
let seed = 42;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function fixture(count: number, span: number) {
  function circle(id: string, index: number): CombatCircle {
    return {
      id,
      position: { x: (random() - 0.5) * span, y: (random() - 0.5) * span },
      radius: index % 13 === 0 ? 256 : 10 + random() * 50,
      immune: index % 11 === 0,
    };
  }
  return {
    ships: Array.from({ length: count }, (_, i) => circle(`ship-${i}`, i)),
    rocks: Array.from({ length: 80 }, (_, i) => circle(`rock-${i}`, i)),
  };
}
const results: object[] = [];
for (const span of [2000, 200]) {
  for (const count of [3, 12, 27, 52]) {
    const worlds = Array.from({ length: 100 }, () => fixture(count, span));
    // Separate semantic verification from timing. Large objects overlap many cells.
    for (const { ships, rocks } of worlds) {
      const found = indexed(ships, rocks);
      assert.deepEqual(found.hits, findShipAsteroidOverlaps(ships, rocks));
      assert.deepEqual(found.pairs, findShipShipPairs(ships));
    }
    const simple = (world: (typeof worlds)[number]) => ({
      hits: findShipAsteroidOverlaps(world.ships, world.rocks),
      pairs: findShipShipPairs(world.ships),
    });
    const accelerated = (world: (typeof worlds)[number]) => indexed(world.ships, world.rocks);
    const baseline: number[] = [];
    const candidate: number[] = [];
    for (let round = 0; round < 12; round++) {
      const order = round % 2 ? [accelerated, simple] : [simple, accelerated];
      for (const run of order) {
        const start = performance.now();
        for (const world of worlds) {
          run(world);
        }
        (run === simple ? baseline : candidate).push((performance.now() - start) / worlds.length);
      }
    }
    const measurement: Measurement = {
      primaryMetric: 'baselineBatchMeanMs',
      samples: { baselineBatchMeanMs: baseline, candidateBatchMeanMs: candidate },
      counts: { worlds: worlds.length, ships: count, rocks: 80, matchedOutcomes: worlds.length },
      parameters: { seed: 42, span, cell: CELL, scenarioVersion: 1 },
      witness: { identicalCollisionPriority: true },
      cleanup: 'complete',
    };
    validateMeasurement(measurement);
    results.push(measurement);
  }
}
const output = process.argv[2];
assert(output, 'Pass an output JSON path');
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      experiment: 'uniform-grid-circle-candidates',
      scope:
        'Circle broad phase only; index construction and dedup included. Swept projectiles unchanged and excluded. Batch means are not individual tick quantiles. No production adoption.',
      results,
    },
    null,
    2
  )}\n`
);
