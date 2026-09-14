import { EMPTY_EXPLORATION } from '../../shared/exploration';
import type { ExplorationTile, MapAsset } from '../../shared-types';

let exploration: ExplorationTile[] = EMPTY_EXPLORATION;
let mapAssets: MapAsset[] = [];
let completedSectors = new Set<string>();

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

export function getCompletedSectors(): ReadonlySet<string> {
  return completedSectors;
}

export function setCompletedSectors(ids: readonly string[]): void {
  completedSectors = new Set(ids);
}

export function resetWorldExploration(): void {
  mapAssets = [];
  exploration = EMPTY_EXPLORATION;
  completedSectors = new Set();
}
