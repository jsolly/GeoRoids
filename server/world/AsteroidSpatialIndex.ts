import type { AsteroidData } from '../../shared-types';

interface QueryBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const CELL_SIZE = 512;

/** A frame-local broad phase shared by hull, swept-laser and snapshot queries. */
export class AsteroidSpatialIndex {
  private readonly cells = new Map<string, Array<{ rock: AsteroidData; order: number }>>();
  private nextOrder = 0;

  constructor(asteroids: readonly AsteroidData[]) {
    for (const rock of asteroids) {
      this.add(rock);
    }
  }

  /** Mining fragments join the same frame's index before the next shot resolves. */
  add(rock: AsteroidData): void {
    const radius = rock.size * Math.max(1, ...rock.offsets);
    const entry = { rock, order: this.nextOrder++ };
    this.visitCells(
      {
        minX: rock.position.x - radius,
        minY: rock.position.y - radius,
        maxX: rock.position.x + radius,
        maxY: rock.position.y + radius,
      },
      (key) => {
        const cell = this.cells.get(key);
        if (cell) {
          cell.push(entry);
        } else {
          this.cells.set(key, [entry]);
        }
      }
    );
  }

  query(bounds: QueryBounds): AsteroidData[] {
    const found = new Map<string, { rock: AsteroidData; order: number }>();
    this.visitCells(bounds, (key) => {
      for (const entry of this.cells.get(key) ?? []) {
        found.set(entry.rock.id, entry);
      }
    });
    // Existing collision semantics choose the first source asteroid on overlapping hulls.
    return [...found.values()].sort((a, b) => a.order - b.order).map((entry) => entry.rock);
  }

  private visitCells(bounds: QueryBounds, visit: (key: string) => void): void {
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
        visit(`${x},${y}`);
      }
    }
  }
}
