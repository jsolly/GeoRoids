import { expect, test, vi } from 'vitest';
import {
  ExplorationMap,
  explorationCellAt,
  isCellExplored,
  validExploration,
} from '../../../shared/exploration';
import { WORLD } from '../../../shared/world';
import type { ExplorationTile } from '../../../shared-types';

const CELLS_PER_SECTOR = 16;
const GRID = (WORLD.radius * 2) / (WORLD.sectorSize / CELLS_PER_SECTOR);
const oldIndexes = new WeakMap<readonly ExplorationTile[], Map<string, string>>();

/** Frozen pre-optimization lookup, including canonical IDs and byte/bit ordering. */
function oldLookup(tiles: readonly ExplorationTile[], cell: number): boolean {
  let index = oldIndexes.get(tiles);
  if (!index) {
    index = new Map(tiles.map((tile) => [tile.id, tile.bits]));
    oldIndexes.set(tiles, index);
  }
  const col = cell % GRID;
  const row = Math.floor(cell / GRID);
  const offset = (row % CELLS_PER_SECTOR) * CELLS_PER_SECTOR + (col % CELLS_PER_SECTOR);
  const address = {
    id: `${Math.floor(col / CELLS_PER_SECTOR)},${Math.floor(row / CELLS_PER_SECTOR)}`,
    byte: Math.floor(offset / 8),
    bit: offset % 8,
  };
  const bits = index.get(address.id);
  if (!bits) {
    return false;
  }
  return (
    (Number.parseInt(bits.slice(address.byte * 2, address.byte * 2 + 2), 16) &
      (1 << address.bit)) !==
    0
  );
}

test('radar preserves every sector bit, byte seam and world edge after decoding', () => {
  const tiles = Object.freeze([
    Object.freeze({ id: '0,0', bits: `01${'00'.repeat(30)}80` }),
    ...['1,0', '0,1', '29,30', '59,59'].map((id, tile) =>
      Object.freeze({
        id,
        bits: Array.from({ length: 32 }, (_, byte) =>
          ((byte * 17 + tile * 23) ^ 0xa5).toString(16).slice(-2).padStart(2, '0')
        ).join(''),
      })
    ),
    // Validation historically accepts this spelling, but canonical cell lookup
    // must never let it alias or overwrite sector 0,0.
    Object.freeze({ id: '00,0', bits: 'ff'.repeat(32) }),
  ]);
  expect(validExploration(tiles)).toBe(true);
  const cells: number[] = [
    -GRID - 1,
    -1,
    0,
    1,
    7,
    8,
    15,
    16,
    GRID - 1,
    GRID,
    GRID * GRID - 1,
    GRID * GRID,
    NaN,
    Infinity,
    0.5,
    7.999,
  ];
  for (const [sectorCol, sectorRow] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [29, 30],
    [59, 59],
  ] satisfies [number, number][]) {
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        cells.push((sectorRow * 16 + row) * GRID + sectorCol * 16 + col);
      }
    }
  }
  expect(cells.map((cell) => isCellExplored(tiles, cell))).toEqual(
    cells.map((cell) => oldLookup(tiles, cell))
  );
  expect(isCellExplored(tiles, 0)).toBe(true);
  expect(isCellExplored(tiles, 1)).toBe(false);
  expect(isCellExplored(tiles, 15 * GRID + 15)).toBe(true);
  expect(explorationCellAt({ x: -WORLD.radius, y: -WORLD.radius })).toBe(0);
  expect(explorationCellAt({ x: WORLD.radius - 0.001, y: WORLD.radius - 0.001 })).toBe(
    GRID * GRID - 1
  );
  expect(explorationCellAt({ x: WORLD.radius, y: 0 })).toBeNull();
  expect(explorationCellAt({ x: -WORLD.radius - 0.001, y: 0 })).toBeNull();
  const lastWins = [
    { id: '0,0', bits: 'ff'.repeat(32) },
    { id: '0,0', bits: '00'.repeat(32) },
  ];
  expect(isCellExplored(lastWins, 0)).toBe(oldLookup(lastWins, 0));
  expect(isCellExplored(lastWins, 0)).toBe(false);
});

test('later reveals, restores and resets leave retained exploration snapshots unchanged', () => {
  const map = new ExplorationMap();
  const firstPosition = { x: 62.5, y: 62.5 };
  const nextPosition = { x: 187.5, y: 62.5 };
  const firstCell = explorationCellAt(firstPosition);
  const nextCell = explorationCellAt(nextPosition);
  if (firstCell === null || nextCell === null) {
    throw new Error('Fixture outside world');
  }
  map.reveal(firstPosition, 1);
  const old = map.snapshot();
  old.forEach(Object.freeze);
  Object.freeze(old);
  const originalEncoding = JSON.stringify(old);
  expect(isCellExplored(old, firstCell)).toBe(true);
  expect(isCellExplored(old, nextCell)).toBe(false);
  map.reveal(nextPosition, 1);
  const newer = map.snapshot();
  expect(newer).not.toBe(old);
  expect(isCellExplored(newer, nextCell)).toBe(true);
  expect(isCellExplored(old, nextCell)).toBe(false);
  const saved = [{ id: '59,59', bits: 'ff'.repeat(32) }];
  saved.forEach(Object.freeze);
  Object.freeze(saved);
  map.restore(saved);
  const restored = map.snapshot();
  expect(restored).not.toBe(saved);
  expect(restored[0]).not.toBe(saved[0]);
  expect(isCellExplored(restored, GRID * GRID - 1)).toBe(true);
  expect(isCellExplored(newer, nextCell)).toBe(true);
  expect(isCellExplored(old, nextCell)).toBe(false);
  map.reset();
  expect(isCellExplored(map.snapshot(), firstCell)).toBe(false);
  expect(isCellExplored(restored, GRID * GRID - 1)).toBe(true);
  expect(JSON.stringify(old)).toBe(originalEncoding);
  expect(saved).toEqual([{ id: '59,59', bits: 'ff'.repeat(32) }]);
});

test('repeated radar flight lookups reuse local decoded bytes without parsing remote tiles', () => {
  let bitsReads = 0;
  const tiles = Object.freeze(
    Array.from({ length: 60 }, (_, sector) =>
      Object.freeze({
        id: `${sector},0`,
        get bits() {
          bitsReads++;
          return 'a5'.repeat(32);
        },
      })
    )
  );
  const parse = vi.spyOn(Number, 'parseInt');
  try {
    expect(isCellExplored(tiles, 0)).toBe(true);
    expect(bitsReads).toBe(60);
    // The numeric sector index captures immutable strings once, but only the
    // sector under this radar is decoded. Distant sectors incur no byte parsing.
    expect(parse.mock.calls.length).toBe(32);
    oldLookup(tiles, 0);
    bitsReads = 0;
    parse.mockClear();
    let explored = 0;
    for (let frame = 0; frame < 120; frame++) {
      for (let cell = 0; cell < 16; cell++) {
        explored += Number(isCellExplored(tiles, cell));
      }
    }
    const warmParses = parse.mock.calls.length;
    const warmReads = bitsReads;
    expect(explored).toBe(120 * 8);
    expect(warmParses).toBe(0);
    expect(warmReads).toBe(0);
    parse.mockClear();
    for (let cell = 0; cell < 16; cell++) {
      oldLookup(tiles, cell);
    }
    expect(parse.mock.calls.length).toBe(16);
    parse.mockClear();
    isCellExplored(tiles, 16);
    expect(parse.mock.calls.length).toBe(32);
    parse.mockClear();
    isCellExplored(tiles, 16);
    expect(parse.mock.calls.length).toBe(0);
    expect(bitsReads).toBe(0);
  } finally {
    parse.mockRestore();
  }
});
