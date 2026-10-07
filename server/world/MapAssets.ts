import { isEquipmentId } from '../../shared/equipment';
import { type ExplorationMap, explorationCellAt, isCellExplored } from '../../shared/exploration';
import { CIVIC_LOTS, FURNACES } from '../../shared/furnaces';
import type { ExplorationTile, LootData, MapAsset, SatellitePickupData } from '../../shared-types';
import type { LootCatalogObserver } from '../core/LootManager';

type LootAsset = { asset: MapAsset; ordinal: number };

/** Crew knowledge advances at snapshots and outlives the local viewport. */
export class MapAssets implements LootCatalogObserver {
  private readonly records = new Map<string, LootAsset>();
  private readonly knownLoot = new Map<string, LootAsset>();
  private readonly dirtyLoot = new Set<string>();
  private readonly pendingInitialVisible = new Set<string>();
  private readonly knownSatellites = new Set<string>();
  private sortedLoot: LootAsset[] = [];

  constructor(private readonly exploration: Pick<ExplorationMap, 'snapshot'>) {}

  changed(drop: LootData, insertionOrdinal: number): void {
    this.pendingInitialVisible.delete(drop.id);
    if (
      drop.kind === 'shard' ||
      drop.kind === 'tap' ||
      drop.kind === 'silk' ||
      isEquipmentId(drop.kind)
    ) {
      this.records.delete(drop.id);
    } else {
      this.records.set(drop.id, {
        ordinal: insertionOrdinal,
        asset: {
          id: `loot:${drop.id}`,
          kind: 'wreckage',
          position: { ...drop.position },
          name: 'Cargo',
        },
      });
    }
    this.dirtyLoot.add(drop.id);
  }

  moved(drop: LootData): void {
    const current = this.records.get(drop.id);
    if (!current) {
      return;
    }
    this.pendingInitialVisible.delete(drop.id);
    this.records.set(drop.id, {
      ordinal: current.ordinal,
      asset: { ...current.asset, position: { ...drop.position } },
    });
    this.dirtyLoot.add(drop.id);
  }

  removed(id: string): void {
    this.pendingInitialVisible.delete(id);
    this.records.delete(id);
    this.dirtyLoot.add(id);
  }

  cleared(): void {
    this.records.clear();
    this.pendingInitialVisible.clear();
    this.dirtyLoot.clear();
    for (const id of this.knownLoot.keys()) {
      this.dirtyLoot.add(id);
    }
  }

  discovered(id: string): void {
    this.dirtyLoot.add(id);
  }

  /** Cold startup preparation, without observing or revealing the restored rows. */
  primeInitialLoot(): void {
    const exploration = this.exploration.snapshot();
    this.pendingInitialVisible.clear();
    for (const [id, record] of this.records) {
      if (this.visible(record.asset, exploration)) {
        this.pendingInitialVisible.add(id);
      }
    }
    this.dirtyLoot.clear();
  }

  private visible(asset: MapAsset, exploration: readonly ExplorationTile[]): boolean {
    const cell = explorationCellAt(asset.position);
    return cell !== null && isCellExplored(exploration, cell);
  }

  private reconcileLoot(exploration: readonly ExplorationTile[]): void {
    if (this.pendingInitialVisible.size === 0 && this.dirtyLoot.size === 0) {
      return;
    }
    const changed = new Set([...this.pendingInitialVisible, ...this.dirtyLoot]);
    let knownChanged = false;
    for (const id of changed) {
      const current = this.records.get(id);
      const previous = this.knownLoot.get(id);
      if (!current) {
        knownChanged = this.knownLoot.delete(id) || knownChanged;
      } else if (previous || this.visible(current.asset, exploration)) {
        if (
          previous &&
          previous.ordinal === current.ordinal &&
          previous.asset.kind === current.asset.kind &&
          previous.asset.name === current.asset.name &&
          previous.asset.position.x === current.asset.position.x &&
          previous.asset.position.y === current.asset.position.y
        ) {
          continue;
        }
        this.knownLoot.set(id, current);
        knownChanged = true;
      }
    }
    this.pendingInitialVisible.clear();
    this.dirtyLoot.clear();
    if (!knownChanged) {
      return;
    }
    this.sortedLoot = [...this.knownLoot.entries()]
      .sort(([a, left], [b, right]) => a.localeCompare(b) || left.ordinal - right.ordinal)
      .map(([, record]) => record);
  }

  snapshot(
    pickups: readonly SatellitePickupData[],
    moduleNames: ReadonlyMap<string, string> = new Map()
  ): MapAsset[] {
    const exploration = this.exploration.snapshot();
    this.reconcileLoot(exploration);
    const revealed: MapAsset[] = FURNACES.map((furnace) => ({
      id: `furnace:${furnace.id}`,
      kind: 'furnace',
      position: furnace.position,
      name: furnace.name,
    }));
    for (const lot of CIVIC_LOTS) {
      const builtName = moduleNames.get(lot.id);
      revealed.push({
        id: `furnace:${lot.id}`,
        kind: builtName === undefined ? 'foundation' : 'furnace',
        position: lot.position,
        name: builtName ?? lot.name,
      });
    }
    for (const { asset } of this.sortedLoot) {
      revealed.push({ ...asset, position: { ...asset.position } });
    }
    const satellites = new Set<string>();
    for (const pickup of pickups) {
      const id = `satellite:${pickup.id}`;
      const asset: MapAsset = {
        id,
        kind: 'satellite',
        position: pickup.position,
        name: pickup.name,
      };
      if (
        pickup.state === 'loose' &&
        (this.knownSatellites.has(id) || this.visible(asset, exploration))
      ) {
        revealed.push(asset);
        satellites.add(id);
      }
    }
    this.knownSatellites.clear();
    for (const id of satellites) {
      this.knownSatellites.add(id);
    }
    return revealed;
  }

  reset(): void {
    this.records.clear();
    this.knownLoot.clear();
    this.dirtyLoot.clear();
    this.pendingInitialVisible.clear();
    this.knownSatellites.clear();
    this.sortedLoot = [];
  }
}
