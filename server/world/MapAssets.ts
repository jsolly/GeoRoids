import { explorationCellAt, isCellExplored } from '../../shared/exploration';
import { CIVIC_LOTS, FURNACES } from '../../shared/furnaces';
import type { ExplorationTile, LootData, MapAsset, SatellitePickupData } from '../../shared-types';

/** Crew knowledge outlives the local viewport; consumed assets leave the shared map. */
export class MapAssets {
  private known = new Set<string>();

  snapshot(
    exploration: readonly ExplorationTile[],
    loot: readonly LootData[],
    pickups: readonly SatellitePickupData[],
    moduleNames: ReadonlyMap<string, string> = new Map()
  ): MapAsset[] {
    const candidates: MapAsset[] = FURNACES.map((furnace) => ({
      id: `furnace:${furnace.id}`,
      kind: 'furnace',
      position: furnace.position,
      name: furnace.name,
    }));
    for (const lot of CIVIC_LOTS) {
      const builtName = moduleNames.get(lot.id);
      candidates.push({
        id: `furnace:${lot.id}`,
        kind: builtName === undefined ? 'foundation' : 'furnace',
        position: lot.position,
        name: builtName ?? lot.name,
      });
    }
    for (const drop of loot) {
      if (drop.kind === 'shard' || drop.kind === 'tap' || drop.kind === 'silk') {
        continue;
      }
      candidates.push({
        id: `loot:${drop.id}`,
        kind: drop.kind,
        position: drop.position,
        name: drop.kind === 'laserCore' ? 'Laser core' : 'Salvage',
      });
    }
    for (const pickup of pickups) {
      if (pickup.state === 'loose') {
        candidates.push({
          id: `satellite:${pickup.id}`,
          kind: 'satellite',
          position: pickup.position,
          name: pickup.name,
        });
      }
    }
    const revealed = candidates.filter((asset) => {
      if (asset.kind === 'furnace' || asset.kind === 'foundation' || this.known.has(asset.id)) {
        return true;
      }
      const cell = explorationCellAt(asset.position);
      return cell !== null && isCellExplored(exploration, cell);
    });
    this.known = new Set(revealed.map((asset) => asset.id));
    return revealed;
  }

  reset(): void {
    this.known.clear();
  }
}
