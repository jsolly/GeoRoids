import { emptySettlement } from '../../shared/economy';
import { EMPTY_EXPLORATION } from '../../shared/exploration';
import { FurnaceField } from '../../shared/furnaceField';
import type { ExplorationTile, MapAsset, SettlementState } from '../../shared-types';

export const worldFurnaces = new FurnaceField();

let settlement = emptySettlement();
export function getSettlement(): SettlementState {
  return settlement;
}
export function setSettlement(value: SettlementState): void {
  settlement = value;
}

let exploration: ExplorationTile[] = EMPTY_EXPLORATION;
let atlasSyncing = true;
export function isAtlasSyncing(): boolean {
  return atlasSyncing;
}
export function setAtlasSyncing(value: boolean): void {
  atlasSyncing = value;
}
export function resetAtlasState(): void {
  exploration = EMPTY_EXPLORATION;
  atlasSyncing = true;
}
let mapAssets: MapAsset[] = [];
let remains: MapAsset[] = [];
export function getWorldRemains(): readonly MapAsset[] {
  return remains;
}

export function getWorldMapAssets(): readonly MapAsset[] {
  return mapAssets;
}
export function setWorldMapAssets(value: MapAsset[]): void {
  mapAssets = value;
  remains = value.filter((asset) => asset.kind === 'ship-remains' || asset.kind === 'nest-remains');
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
  resetAtlasState();
  worldFurnaces.replaceLit([]);
  worldFurnaces.replaceFrontier([]);
  settlement = emptySettlement();
  mapAssets = [];
  remains = [];
  exploration = EMPTY_EXPLORATION;
}
