import type { ExplorationTile, Position } from '../shared-types';
import { WORLD } from './world';

const CELLS_PER_SECTOR = 16;
const CELL_SIZE = WORLD.sectorSize / CELLS_PER_SECTOR;
const EXPLORATION_GRID_SIZE = (WORLD.radius * 2) / CELL_SIZE;
export const EXPLORATION_RANGE = { scout: 650, hauler: 260 };
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

const SECTORS_PER_AXIS = EXPLORATION_GRID_SIZE / CELLS_PER_SECTOR;
export const MAX_EXPLORATION_TILES = SECTORS_PER_AXIS ** 2;
const REVISION_TREE_LEAVES = 2 ** Math.ceil(Math.log2(MAX_EXPLORATION_TILES));

export interface AtlasIdentity {
  readonly epoch: number;
  readonly revision: number;
  readonly slots: number;
  readonly encodedBytes: number;
}

export interface AtlasTile extends Readonly<ExplorationTile> {
  readonly slot: number;
  readonly revision: number;
}
// Snapshot identity owns one index. Decode only queried sectors, retaining no history
// after that immutable snapshot becomes unreachable.
const indexes = new WeakMap<readonly ExplorationTile[], Map<number, string | Uint8Array>>();
function explorationIndex(tiles: readonly ExplorationTile[]): Map<number, string | Uint8Array> {
  let index = indexes.get(tiles);
  if (!index) {
    index = new Map();
    for (const tile of tiles) {
      const id = tile.id;
      const comma = id.indexOf(',');
      const col = Number(id.slice(0, comma));
      const row = Number(id.slice(comma + 1));
      // The old string lookup matched canonical addresses only. Leading zero IDs
      // must not alias a canonical sector, even though validation accepts them.
      if (
        !Number.isSafeInteger(col) ||
        !Number.isSafeInteger(row) ||
        col < 0 ||
        row < 0 ||
        col >= SECTORS_PER_AXIS ||
        row >= SECTORS_PER_AXIS ||
        `${col},${row}` !== id
      ) {
        continue;
      }
      index.set(row * SECTORS_PER_AXIS + col, tile.bits);
    }
    indexes.set(tiles, index);
  }
  return index;
}

function tileBytes(index: Map<number, string | Uint8Array>, key: number): Uint8Array | undefined {
  let bytes = index.get(key);
  if (bytes === undefined) {
    return undefined;
  }
  if (typeof bytes === 'string') {
    const encoded = bytes;
    bytes = new Uint8Array(Math.ceil(encoded.length / 2));
    for (let byte = 0; byte < bytes.length; byte++) {
      bytes[byte] = Number.parseInt(encoded.slice(byte * 2, byte * 2 + 2), 16);
    }
    index.set(key, bytes);
  }
  return bytes;
}

export function isCellExplored(tiles: readonly ExplorationTile[], cell: number): boolean {
  const col = cell % EXPLORATION_GRID_SIZE;
  const row = Math.floor(cell / EXPLORATION_GRID_SIZE);
  const sectorCol = Math.floor(col / CELLS_PER_SECTOR);
  const sectorRow = Math.floor(row / CELLS_PER_SECTOR);
  if (
    sectorCol < 0 ||
    sectorRow < 0 ||
    sectorCol >= SECTORS_PER_AXIS ||
    sectorRow >= SECTORS_PER_AXIS
  ) {
    return false;
  }
  const bytes = tileBytes(explorationIndex(tiles), sectorRow * SECTORS_PER_AXIS + sectorCol);
  const offset = (row % CELLS_PER_SECTOR) * CELLS_PER_SECTOR + (col % CELLS_PER_SECTOR);
  return ((bytes?.[Math.floor(offset / 8)] ?? 0) & (1 << (offset % 8))) !== 0;
}

/** Sparse immutable snapshot traversal for chart raster rebuilds, outside the game loop. */
export function* exploredCells(tiles: readonly ExplorationTile[]): Generator<number> {
  const index = explorationIndex(tiles);
  for (const key of index.keys()) {
    const bytes = tileBytes(index, key);
    if (!bytes) {
      continue;
    }
    const sectorCol = key % SECTORS_PER_AXIS;
    const sectorRow = Math.floor(key / SECTORS_PER_AXIS);
    for (let offset = 0; offset < CELLS_PER_SECTOR ** 2; offset++) {
      if (((bytes[Math.floor(offset / 8)] ?? 0) & (1 << (offset % 8))) !== 0) {
        yield (sectorRow * CELLS_PER_SECTOR + Math.floor(offset / CELLS_PER_SECTOR)) *
          EXPLORATION_GRID_SIZE +
          sectorCol * CELLS_PER_SECTOR +
          (offset % CELLS_PER_SECTOR);
      }
    }
  }
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
      tile === null ||
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
  // These indexes contain identity/revision only. The tile Map alone owns bits.
  private readonly slotIds: string[] = [];
  private readonly tileSlots = new Map<string, number>();
  private readonly revisions: number[] = [];
  private readonly revisionTree = new Float64Array(REVISION_TREE_LEAVES * 2);
  private epoch = 1;
  private revision = 0;
  private encodedBytes = 2;
  private encoded: ExplorationTile[] = [];
  /** Set by `reveal`, cleared by the next `snapshot`: the re-encode is O(explored world). */
  private encodedStale = false;

  reveal(position: Position, range: number): number[] {
    const changed: number[] = [];
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
      this.writeRevealedTile(
        address.id,
        bits.slice(0, offset) + after.toString(16).padStart(2, '0') + bits.slice(offset + 2)
      );
      changed.push(cell);
    }
    return changed;
  }

  private writeRevealedTile(id: string, bits: string): void {
    this.tiles.set(id, bits);
    this.encodedStale = true;
    this.indexTile(id);
  }

  private indexTile(id: string): void {
    let slot = this.tileSlots.get(id);
    if (slot === undefined) {
      slot = this.slotIds.length;
      this.slotIds.push(id);
      this.tileSlots.set(id, slot);
      // IDs and bits are ASCII and contain no JSON escapes.
      this.encodedBytes += id.length + EMPTY_BITS.length + 19 + (slot > 0 ? 1 : 0);
    }
    const revision = ++this.revision;
    this.revisions[slot] = revision;
    let node = REVISION_TREE_LEAVES + slot;
    this.revisionTree[node] = revision;
    while (node > 1) {
      node = Math.floor(node / 2);
      this.revisionTree[node] = Math.max(
        this.revisionTree[node * 2] ?? 0,
        this.revisionTree[node * 2 + 1] ?? 0
      );
    }
  }

  hasCell(cell: number): boolean {
    const address = tileAddress(cell);
    const bits = this.tiles.get(address.id);
    return (
      bits !== undefined &&
      (Number.parseInt(bits.slice(address.byte * 2, address.byte * 2 + 2), 16) &
        (1 << address.bit)) !==
        0
    );
  }

  atlasIdentity(): AtlasIdentity {
    return {
      epoch: this.epoch,
      revision: this.revision,
      slots: this.slotIds.length,
      encodedBytes: this.encodedBytes,
    };
  }

  /** Skip unchanged subtrees; never materialize or filter the complete atlas. */
  nextAtlasTile(query: {
    afterSlot: number;
    endSlot: number;
    afterRevision: number;
  }): AtlasTile | undefined {
    const visit = (node: number, low: number, high: number): number | undefined => {
      if (
        high <= query.afterSlot ||
        low >= query.endSlot ||
        (this.revisionTree[node] ?? 0) <= query.afterRevision
      ) {
        return undefined;
      }
      if (high - low === 1) {
        return low;
      }
      const middle = (low + high) / 2;
      return visit(node * 2, low, middle) ?? visit(node * 2 + 1, middle, high);
    };
    const slot = visit(1, 0, REVISION_TREE_LEAVES);
    if (slot === undefined) {
      return undefined;
    }
    const id = this.slotIds[slot];
    const revision = this.revisions[slot];
    if (id === undefined || revision === undefined) {
      throw new Error('Missing atlas index entry');
    }
    const bits = this.tiles.get(id);
    if (bits === undefined) {
      throw new Error('Missing authoritative atlas tile');
    }
    return { slot, id, bits, revision };
  }

  private clearAtlasIndex(): void {
    this.slotIds.length = 0;
    this.tileSlots.clear();
    this.revisions.length = 0;
    this.revisionTree.fill(0);
    this.revision = 0;
    this.encodedBytes = 2;
    this.epoch++;
  }

  snapshot(): ExplorationTile[] {
    if (this.encodedStale) {
      this.encoded = Array.from(this.tiles, ([id, bits]) => ({ id, bits }));
      this.encodedStale = false;
    }
    return this.encoded;
  }
  restore(tiles: ExplorationTile[]): void {
    if (!validExploration(tiles)) {
      throw new Error('Invalid saved exploration grid');
    }
    this.tiles = new Map(tiles.map((tile) => [tile.id, tile.bits]));
    this.clearAtlasIndex();
    for (const id of this.tiles.keys()) {
      this.indexTile(id);
    }
    this.encoded = tiles.map((tile) => ({ ...tile }));
    this.encodedStale = false;
  }
  reset(): void {
    this.tiles.clear();
    this.clearAtlasIndex();
    this.encoded = [];
    this.encodedStale = false;
  }
}
