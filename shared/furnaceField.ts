import type { BuiltFurnace, Position } from '../shared-types';
import { FURNACES, nearestFurnace } from './furnaces';
import { circleOverlapsBounds, sectorBounds } from './sectors';
import { sectorAt, WORLD } from './world';

export const FURNACE_BUILD = {
  MAX_PER_OWNER: 3,
  RADIUS: 85,
  MIN_DISTANCE: 400,
  /** Leaves room for the 180-unit respawn ring and either ship hull. */
  WORLD_INSET: 500,
  NOTICE: {
    BUILT: 'Furnace built',
    YIELDED: 'Your oldest furnace made way for this new hearth.',
  },
} as const;

function furnaceSerial(site: BuiltFurnace): number {
  const suffix = site.id.slice(site.id.lastIndexOf(':') + 1);
  const serial = Number(suffix);
  return Number.isSafeInteger(serial) && serial > 0 ? serial : Number.POSITIVE_INFINITY;
}

/** Oldest first: explicit placement time, then the id serial used before placedAt existed. */
export function furnacePlacementOrder(site: BuiltFurnace): number {
  return typeof site.placedAt === 'number' && Number.isFinite(site.placedAt)
    ? site.placedAt
    : furnaceSerial(site);
}

function byOldestPlacement(left: BuiltFurnace, right: BuiltFurnace): number {
  return (
    furnacePlacementOrder(left) - furnacePlacementOrder(right) ||
    furnaceSerial(left) - furnaceSerial(right) ||
    left.id.localeCompare(right.id)
  );
}

const CELL_SIZE = 1_000;
type Furnace = (typeof FURNACES)[number];

/** Saved structures are validated once at the storage or snapshot boundary. */
export function validBuiltFurnaces(value: unknown): value is BuiltFurnace[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  return value.every((site: unknown) => {
    if (
      !site ||
      typeof site !== 'object' ||
      !('id' in site) ||
      typeof site.id !== 'string' ||
      !site.id.startsWith('built:') ||
      ids.has(site.id) ||
      !('ownerId' in site) ||
      typeof site.ownerId !== 'string' ||
      site.ownerId.length === 0 ||
      !('name' in site) ||
      typeof site.name !== 'string' ||
      site.name.length === 0 ||
      !('radius' in site) ||
      site.radius !== FURNACE_BUILD.RADIUS ||
      !('position' in site) ||
      !site.position ||
      typeof site.position !== 'object' ||
      !('x' in site.position) ||
      typeof site.position.x !== 'number' ||
      !('y' in site.position) ||
      typeof site.position.y !== 'number' ||
      !Number.isFinite(site.position.x) ||
      !Number.isFinite(site.position.y) ||
      Math.hypot(site.position.x, site.position.y) > WORLD.radius - FURNACE_BUILD.WORLD_INSET ||
      ('placedAt' in site && (typeof site.placedAt !== 'number' || !Number.isFinite(site.placedAt)))
    ) {
      return false;
    }
    ids.add(site.id);
    const count = (counts.get(site.ownerId) ?? 0) + 1;
    counts.set(site.ownerId, count);
    return count <= FURNACE_BUILD.MAX_PER_OWNER;
  });
}

/** Per-world structures, indexed so simulation queries never walk every player's buildings. */
export class FurnaceField {
  private built: BuiltFurnace[] = [];
  private readonly cells = new Map<string, Furnace[]>();
  private readonly counts = new Map<string, number>();
  private readonly sectors = new Set<string>();

  constructor() {
    this.replace([]);
  }

  snapshot(): BuiltFurnace[] {
    return this.built;
  }

  count(ownerId: string): number {
    return this.counts.get(ownerId) ?? 0;
  }

  replace(sites: readonly BuiltFurnace[]): void {
    if (
      this.cells.size > 0 &&
      sites.length === this.built.length &&
      sites.every((site, index) => {
        const previous = this.built[index];
        return (
          previous?.id === site.id &&
          previous.ownerId === site.ownerId &&
          previous.name === site.name &&
          previous.radius === site.radius &&
          previous.position.x === site.position.x &&
          previous.position.y === site.position.y &&
          previous.placedAt === site.placedAt
        );
      })
    ) {
      return;
    }
    this.built = [...sites];
    this.cells.clear();
    this.counts.clear();
    this.sectors.clear();
    for (const site of FURNACES) {
      this.index(site);
    }
    for (const site of sites) {
      this.counts.set(site.ownerId, this.count(site.ownerId) + 1);
      this.index(site);
    }
  }

  add(site: BuiltFurnace): void {
    this.built = [...this.built, site];
    this.counts.set(site.ownerId, this.count(site.ownerId) + 1);
    this.index(site);
  }

  owned(ownerId: string): BuiltFurnace[] {
    return this.built.filter((site) => site.ownerId === ownerId);
  }

  nextOwnedSerial(ownerId: string): number {
    let next = 1;
    for (const site of this.owned(ownerId)) {
      const serial = furnaceSerial(site);
      if (serial !== Number.POSITIVE_INFINITY && serial >= next) {
        next = serial + 1;
      }
    }
    return next;
  }

  evictOldestOwned(ownerId: string): BuiltFurnace | undefined {
    const oldest = this.owned(ownerId).slice().sort(byOldestPlacement)[0];
    if (!oldest) {
      return undefined;
    }
    this.replace(this.built.filter((site) => site.id !== oldest.id));
    return oldest;
  }

  hasSector(id: string): boolean {
    return this.sectors.has(id);
  }

  private index(site: Furnace): void {
    for (const x of [site.position.x - site.radius, site.position.x + site.radius]) {
      for (const y of [site.position.y - site.radius, site.position.y + site.radius]) {
        const sector = sectorAt({ x, y });
        if (circleOverlapsBounds(site.position, site.radius, sectorBounds(sector.x, sector.y))) {
          this.sectors.add(sector.id);
        }
      }
    }
    const key = `${Math.floor(site.position.x / CELL_SIZE)},${Math.floor(site.position.y / CELL_SIZE)}`;
    const cell = this.cells.get(key) ?? [];
    cell.push(site);
    this.cells.set(key, cell);
  }

  nearby(position: Position, radius: number): Furnace[] {
    const found: Furnace[] = [];
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

  nearest(position: Position): Furnace {
    // Fixed landmarks bound the search even when no player has built nearby.
    let nearest = nearestFurnace(position);
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
