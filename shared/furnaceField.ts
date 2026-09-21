import type { Position } from '../shared-types';
import { civicLot, FURNACES, nearestFurnace, TOWN_HEARTH } from './furnaces';

export const FURNACE_BUILD = {
  RADIUS: TOWN_HEARTH.radius,
  ISSUE: {
    NEST: 'Too close to a spider nest',
    STAND: 'Stand inside a street foundation',
    LIT: 'This street is already burning',
    READY: 'Furnace builder not ready',
  },
} as const;

const CELL_SIZE = 1_000;

interface Hearth {
  id: string;
  name: string;
  position: Position;
  radius: number;
}

/** Lit hearths only. Dark street lots stay out of intake, guidance, and spider safety. */
export class FurnaceField {
  private litIds: string[] = [];
  private readonly lit = new Set<string>();
  private readonly cells = new Map<string, Hearth[]>();

  constructor() {
    this.reindex();
  }

  litLotIds(): readonly string[] {
    return this.litIds;
  }

  isLit(id: string): boolean {
    return id === TOWN_HEARTH.id || this.lit.has(id);
  }

  replaceLit(ids: readonly string[]): void {
    if (ids.length === this.litIds.length && ids.every((id, index) => id === this.litIds[index])) {
      return;
    }
    this.litIds = [...ids];
    this.lit.clear();
    for (const id of this.litIds) {
      this.lit.add(id);
    }
    this.reindex();
  }

  light(id: string): void {
    if (this.lit.has(id) || !civicLot(id)) {
      return;
    }
    this.litIds = [...this.litIds, id];
    this.lit.add(id);
    this.reindex();
  }

  private reindex(): void {
    this.cells.clear();
    for (const site of FURNACES) {
      this.index(site);
    }
    for (const id of this.litIds) {
      const lot = civicLot(id);
      if (lot) {
        this.index(lot);
      }
    }
  }

  private index(site: Hearth): void {
    const key = `${Math.floor(site.position.x / CELL_SIZE)},${Math.floor(site.position.y / CELL_SIZE)}`;
    const cell = this.cells.get(key) ?? [];
    cell.push(site);
    this.cells.set(key, cell);
  }

  nearby(position: Position, radius: number): Hearth[] {
    const found: Hearth[] = [];
    for (
      let x = Math.floor((position.x - radius) / CELL_SIZE);
      x <= Math.floor((position.x + radius) / CELL_SIZE);
      x++
    ) {
      for (
        let y = Math.floor((position.y - radius) / CELL_SIZE);
        y <= Math.floor((position.y + radius) / CELL_SIZE);
        y++
      ) {
        for (const site of this.cells.get(`${x},${y}`) ?? []) {
          if (Math.hypot(position.x - site.position.x, position.y - site.position.y) <= radius) {
            found.push(site);
          }
        }
      }
    }
    return found;
  }

  nearest(position: Position): Hearth {
    let nearest: Hearth = nearestFurnace(position);
    let distance = Math.hypot(position.x - nearest.position.x, position.y - nearest.position.y);
    for (const site of this.nearby(position, distance)) {
      const candidate = Math.hypot(position.x - site.position.x, position.y - site.position.y);
      if (candidate < distance) {
        nearest = site;
        distance = candidate;
      }
    }
    return nearest;
  }
}
