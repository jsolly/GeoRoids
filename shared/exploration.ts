import type { ExplorationTile, Position } from '../shared-types';
import { WORLD } from './world';

const CELLS_PER_SECTOR = 16;
const CELL_SIZE = WORLD.sectorSize / CELLS_PER_SECTOR;
const EXPLORATION_GRID_SIZE = (WORLD.radius * 2) / CELL_SIZE;
export const EXPLORATION_RANGE = { surveyor: 650, hauler: 260 };
export const EMPTY_EXPLORATION: ExplorationTile[] = [];
const EMPTY_BITS = '00'.repeat(CELLS_PER_SECTOR ** 2 / 8);
const EXPLORATION_TILE_ID_PATTERN = /^\d+,\d+$/u;
const EXPLORATION_TILE_BITS_PATTERN = /^[0-9a-f]+$/u;

export function explorationCellAt(position: Position): number | null {
  const col = Math.floor((position.x + WORLD.radius) / CELL_SIZE);
  const row = Math.floor((position.y + WORLD.radius) / CELL_SIZE);
  return col >= 0 && row >= 0 && col < EXPLORATION_GRID_SIZE && row < EXPLORATION_GRID_SIZE
    ? row * EXPLORATION_GRID_SIZE + col
    : null;
}

export function cellWorldBounds(index: number): { x: number; y: number; size: number } {
  return {
    x: (index % EXPLORATION_GRID_SIZE) * CELL_SIZE - WORLD.radius,
    y: Math.floor(index / EXPLORATION_GRID_SIZE) * CELL_SIZE - WORLD.radius,
    size: CELL_SIZE,
  };
}

function tileAddress(cell: number): { id: string; byte: number; bit: number } {
  const col = cell % EXPLORATION_GRID_SIZE;
  const row = Math.floor(cell / EXPLORATION_GRID_SIZE);
  const offset = (row % CELLS_PER_SECTOR) * CELLS_PER_SECTOR + (col % CELLS_PER_SECTOR);
  return {
    id: `${Math.floor(col / CELLS_PER_SECTOR)},${Math.floor(row / CELLS_PER_SECTOR)}`,
    byte: Math.floor(offset / 8),
    bit: offset % 8,
  };
}

const indexes = new WeakMap<readonly ExplorationTile[], Map<string, string>>();
export function isCellExplored(tiles: readonly ExplorationTile[], cell: number): boolean {
  let index = indexes.get(tiles);
  if (!index) {
    index = new Map(tiles.map((tile) => [tile.id, tile.bits]));
    indexes.set(tiles, index);
  }
  const address = tileAddress(cell);
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

/** Iterate visible cells only, regardless of the explored world's size. */
export function* explorationCellsInView(bounds: {
  cx: number;
  cy: number;
  radius: number;
}): Generator<number> {
  const minCol = Math.max(0, Math.floor((bounds.cx - bounds.radius + WORLD.radius) / CELL_SIZE));
  const maxCol = Math.min(
    EXPLORATION_GRID_SIZE - 1,
    Math.floor((bounds.cx + bounds.radius + WORLD.radius) / CELL_SIZE)
  );
  const minRow = Math.max(0, Math.floor((bounds.cy - bounds.radius + WORLD.radius) / CELL_SIZE));
  const maxRow = Math.min(
    EXPLORATION_GRID_SIZE - 1,
    Math.floor((bounds.cy + bounds.radius + WORLD.radius) / CELL_SIZE)
  );
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      yield row * EXPLORATION_GRID_SIZE + col;
    }
  }
}

export function validExploration(value: unknown): value is ExplorationTile[] {
  if (!Array.isArray(value) || value.length > (EXPLORATION_GRID_SIZE / CELLS_PER_SECTOR) ** 2) {
    return false;
  }
  const ids = new Set<string>();
  return value.every((tile: unknown) => {
    if (
      !tile ||
      typeof tile !== 'object' ||
      !('id' in tile) ||
      !('bits' in tile) ||
      typeof tile.id !== 'string' ||
      typeof tile.bits !== 'string' ||
      !EXPLORATION_TILE_ID_PATTERN.test(tile.id) ||
      tile.bits.length !== EMPTY_BITS.length ||
      !EXPLORATION_TILE_BITS_PATTERN.test(tile.bits) ||
      ids.has(tile.id)
    ) {
      return false;
    }
    const [col, row] = tile.id.split(',').map(Number);
    if (
      col === undefined ||
      row === undefined ||
      col >= EXPLORATION_GRID_SIZE / CELLS_PER_SECTOR ||
      row >= EXPLORATION_GRID_SIZE / CELLS_PER_SECTOR
    ) {
      return false;
    }
    ids.add(tile.id);
    return true;
  });
}

/** Changed sectors travel as snapshot collection deltas; remote discoveries remain durable. */
export class ExplorationMap {
  private tiles = new Map<string, string>();
  private encoded: ExplorationTile[] = [];

  reveal(position: Position, range: number): void {
    let changed = false;
    for (const cell of explorationCellsInView({ cx: position.x, cy: position.y, radius: range })) {
      const bounds = cellWorldBounds(cell);
      if (
        Math.hypot(bounds.x + CELL_SIZE / 2 - position.x, bounds.y + CELL_SIZE / 2 - position.y) >
        range
      ) {
        continue;
      }
      const address = tileAddress(cell);
      const bits = this.tiles.get(address.id) ?? EMPTY_BITS;
      const before = Number.parseInt(bits.slice(address.byte * 2, address.byte * 2 + 2), 16);
      const after = before | (1 << address.bit);
      if (before === after) {
        continue;
      }
      const offset = address.byte * 2;
      this.tiles.set(
        address.id,
        bits.slice(0, offset) + after.toString(16).padStart(2, '0') + bits.slice(offset + 2)
      );
      changed = true;
    }
    if (changed) {
      this.encoded = Array.from(this.tiles, ([id, bits]) => ({ id, bits }));
    }
  }

  snapshot(): ExplorationTile[] {
    return this.encoded;
  }
  restore(tiles: ExplorationTile[]): void {
    if (!validExploration(tiles)) {
      throw new Error('Invalid saved exploration grid');
    }
    this.tiles = new Map(tiles.map((tile) => [tile.id, tile.bits]));
    this.encoded = tiles.map((tile) => ({ ...tile }));
  }
  reset(): void {
    this.tiles.clear();
    this.encoded = [];
  }
}
