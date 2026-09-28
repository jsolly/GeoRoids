import type { AsteroidData } from '../../shared-types';

interface QueryBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Entry {
  rock: AsteroidData;
  order: number;
  /** Inclusive cell range the rock's hull covers. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const CELL_SIZE = 512;
/** Numeric cell keys avoid a string allocation per visited cell; the world spans far fewer cells. */
const CELL_KEY_OFFSET = 1 << 15;
const CELL_KEY_STRIDE = 1 << 16;

function cellKey(x: number, y: number): number {
  return (x + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + y + CELL_KEY_OFFSET;
}

function hullRadius(rock: AsteroidData): number {
  let extent = 1;
  for (const offset of rock.offsets) {
    extent = Math.max(extent, offset);
  }
  return rock.size * extent;
}

/**
 * Broad phase shared by hull, swept-laser, crawler and snapshot queries.
 *
 * Entries keep the insertion order of their source rows: collision semantics
 * choose the first source asteroid on overlapping hulls. Moving a rock keeps
 * its order, so drift never reorders candidates.
 */
export class AsteroidSpatialIndex {
  private readonly cells = new Map<number, Entry[]>();
  private readonly entries = new Map<string, Entry>();
  private nextOrder = 0;

  constructor(asteroids: Iterable<AsteroidData>) {
    for (const rock of asteroids) {
      this.add(rock);
    }
  }

  /** A replaced row keeps its original order, like `Map.set`. */
  add(rock: AsteroidData): void {
    const existing = this.entries.get(rock.id);
    if (existing) {
      this.unplace(existing);
      existing.rock = rock;
      this.place(existing);
      return;
    }
    const entry: Entry = { rock, order: this.nextOrder++, x0: 0, x1: -1, y0: 0, y1: -1 };
    this.place(entry);
    this.entries.set(rock.id, entry);
  }

  get(id: string): AsteroidData | undefined {
    return this.entries.get(id)?.rock;
  }

  /** Every indexed row in source order: new rows append, replaced rows keep their slot. */
  *values(): IterableIterator<AsteroidData> {
    for (const entry of this.entries.values()) {
      yield entry.rock;
    }
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
  }

  /** Re-file a rock whose position changed; most drift stays inside its cells. */
  move(rock: AsteroidData): void {
    const entry = this.entries.get(rock.id);
    if (!entry) {
      return;
    }
    const radius = hullRadius(rock);
    if (
      Math.floor((rock.position.x - radius) / CELL_SIZE) === entry.x0 &&
      Math.floor((rock.position.x + radius) / CELL_SIZE) === entry.x1 &&
      Math.floor((rock.position.y - radius) / CELL_SIZE) === entry.y0 &&
      Math.floor((rock.position.y + radius) / CELL_SIZE) === entry.y1
    ) {
      return;
    }
    this.unplace(entry);
    this.place(entry);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.entries.delete(id);
    this.unplace(entry);
  }

  private place(entry: Entry): void {
    const { rock } = entry;
    const radius = hullRadius(rock);
    entry.x0 = Math.floor((rock.position.x - radius) / CELL_SIZE);
    entry.x1 = Math.floor((rock.position.x + radius) / CELL_SIZE);
    entry.y0 = Math.floor((rock.position.y - radius) / CELL_SIZE);
    entry.y1 = Math.floor((rock.position.y + radius) / CELL_SIZE);
    for (let y = entry.y0; y <= entry.y1; y++) {
      for (let x = entry.x0; x <= entry.x1; x++) {
        const key = cellKey(x, y);
        const cell = this.cells.get(key);
        if (cell) {
          cell.push(entry);
        } else {
          this.cells.set(key, [entry]);
        }
      }
    }
  }

  private unplace(entry: Entry): void {
    for (let y = entry.y0; y <= entry.y1; y++) {
      for (let x = entry.x0; x <= entry.x1; x++) {
        const key = cellKey(x, y);
        const cell = this.cells.get(key);
        const at = cell?.indexOf(entry) ?? -1;
        if (cell && at >= 0) {
          cell.splice(at, 1);
          if (cell.length === 0) {
            this.cells.delete(key);
          }
        }
      }
    }
  }

  query(bounds: QueryBounds): AsteroidData[] {
    const found = new Set<Entry>();
    this.visitCells(bounds, (key) => {
      for (const entry of this.cells.get(key) ?? []) {
        found.add(entry);
      }
    });
    return [...found].sort((a, b) => a.order - b.order).map((entry) => entry.rock);
  }

  private visitCells(bounds: QueryBounds, visit: (key: number) => void): void {
    for (
      let y = Math.floor(bounds.minY / CELL_SIZE);
      y <= Math.floor(bounds.maxY / CELL_SIZE);
      y++
    ) {
      for (
        let x = Math.floor(bounds.minX / CELL_SIZE);
        x <= Math.floor(bounds.maxX / CELL_SIZE);
        x++
      ) {
        visit(cellKey(x, y));
      }
    }
  }
}
