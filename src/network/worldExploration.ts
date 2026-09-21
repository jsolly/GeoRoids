import { EMPTY_EXPLORATION } from '../../shared/exploration';
import { FurnaceField } from '../../shared/furnaceField';
import type { ExplorationTile, MapAsset } from '../../shared-types';

export const worldFurnaces = new FurnaceField();

let exploration: ExplorationTile[] = EMPTY_EXPLORATION;
let mapAssets: MapAsset[] = [];

export function getWorldMapAssets(): readonly MapAsset[] {
  return mapAssets;
}
export function setWorldMapAssets(value: MapAsset[]): void {
  mapAssets = value;
}

function sameExploration(
  left: readonly ExplorationTile[],
  right: readonly ExplorationTile[]
): boolean {
  return (
    left.length === right.length &&
    left.every((tile, index) => {
      const other = right[index];
      return other?.id === tile.id && other.bits === tile.bits;
    })
  );
}

export function getWorldExploration(): ExplorationTile[] {
  return exploration;
}

export function setWorldExploration(value: ExplorationTile[]): void {
  if (sameExploration(exploration, value)) {
    return;
  }
  exploration = value;
}

export function resetWorldExploration(): void {
  worldFurnaces.replace([]);
  mapAssets = [];
  exploration = EMPTY_EXPLORATION;
}
