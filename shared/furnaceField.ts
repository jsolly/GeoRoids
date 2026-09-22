import type { CivicModule, Position } from '../shared-types';
import {
  civicLot,
  civicLotWithin,
  civicModuleName,
  FURNACES,
  nearestFurnace,
  TOWN_HEARTH,
} from './furnaces';

export const FURNACE_BUILD = {
  RADIUS: TOWN_HEARTH.radius,
  /** World units from a dark lot where Surveyor E becomes Build. */
  APPROACH: 220,
  ISSUE: {
    NEST: 'Too close to a spider nest',
    STAND: 'Stand inside a street foundation',
    LIT: 'This street is already burning',
    READY: 'Furnace builder not ready',
  },
} as const;

/** Surveyor E builds instead of scan/probe while a dark street lot is this close. */
export function surveyorAbilityBuildsAt(
  position: Position,
  isLit: (lotId: string) => boolean
): boolean {
  const lot = civicLotWithin(position, FURNACE_BUILD.APPROACH);
  return Boolean(lot && !isLit(lot.id));
}

const CELL_SIZE = 1_000;

interface Hearth {
  id: string;
  name: string;
  position: Position;
  radius: number;
}

/** Lit hearths only. Dark street lots stay out of intake, guidance, and spider safety. */
export class FurnaceField {
  private modules: CivicModule[] = [];
  private readonly lit = new Set<string>();
  private readonly labels = new Map<string, string>();
  private readonly cells = new Map<string, Hearth[]>();

  constructor() {
    this.reindex();
  }

  litModules(): readonly CivicModule[] {
    return this.modules;
  }

  /** Name shown for a lit module, or the plan name while the lot is still dark. */
  displayName(id: string): string {
    return (
      this.labels.get(id) ?? civicLot(id)?.name ?? (id === TOWN_HEARTH.id ? TOWN_HEARTH.name : '')
    );
  }

  isLit(id: string): boolean {
    return id === TOWN_HEARTH.id || this.lit.has(id);
  }

  modulesBuiltBy(playerId: string) {
    let built = 0;
    for (const module of this.modules) {
      if (module.builderId === playerId) {
        built += 1;
      }
    }
    return built;
  }

  replaceLit(modules: readonly CivicModule[]): void {
    if (
      modules.length === this.modules.length &&
      modules.every(
        (module, index) =>
          module.id === this.modules[index]?.id &&
          module.builderName === this.modules[index]?.builderName &&
          module.builderId === this.modules[index]?.builderId
      )
    ) {
      return;
    }
    this.modules = modules.map((module) => ({
      id: module.id,
      builderName: module.builderName,
      ...(module.builderId ? { builderId: module.builderId } : {}),
    }));
    this.lit.clear();
    for (const module of this.modules) {
      this.lit.add(module.id);
    }
    this.reindex();
  }

  light(id: string, builderName = '', builderId = ''): void {
    if (this.lit.has(id) || !civicLot(id)) {
      return;
    }
    this.modules = [
      ...this.modules,
      builderId ? { id, builderName, builderId } : { id, builderName },
    ];
    this.lit.add(id);
    this.reindex();
  }

  private reindex(): void {
    this.cells.clear();
    this.labels.clear();
    for (const site of FURNACES) {
      this.index(site);
    }
    for (const module of this.modules) {
      const lot = civicLot(module.id);
      if (!lot) {
        continue;
      }
      const name = civicModuleName(module.builderName, lot.name);
      this.labels.set(lot.id, name);
      this.index({ id: lot.id, name, position: lot.position, radius: lot.radius });
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
