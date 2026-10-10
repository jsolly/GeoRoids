import type { HaulerUtilityId, ScoutUtilityId, ShipKitId } from '../../shared-types';
import type { GameOverlayId } from './overlayState';
import type { TownStoreView, TownView } from './townStore';

export type GamePreference = 'sound' | 'music' | 'haptics';

export interface GameMenuView {
  readonly initialName: string;
  readonly fallbackName: string;
  readonly selectedKit: ShipKitId;
  readonly preferences: {
    readonly sound: boolean;
    readonly music: boolean;
    readonly haptics: boolean;
    readonly hapticsAvailable: boolean;
  };
  readonly buildInfo: string;
}

export interface GamePresentation {
  readonly menu: GameMenuView;
  readonly inPlay: boolean;
  readonly joining: boolean;
  readonly joinError: string | null;
  readonly failureNotice: string | null;
  readonly overlay: GameOverlayId | null;
  readonly inventory: InventoryView | null;
  readonly townStore: TownStoreView | null;
}

export interface GameCommands {
  join(name: string): void;
  selectShip(kit: ShipKitId): void;
  setPreference(kind: GamePreference, enabled: boolean): void;
  openTownStore(): void;
  closeTownStore(): void;
  selectTownView(mode: TownView): void;
  purchaseTownOffer(id: string): void;
  mountTownTravel(host: HTMLElement): () => void;
  openInventory(): void;
  closeInventory(): void;
  inventoryPage(page: number): void;
  equipSatellite(id: string): void;
  equipUtility(id: HaulerUtilityId | ScoutUtilityId): void;
  drawInventory(
    hull: HTMLCanvasElement,
    tool: HTMLCanvasElement
  ): { refresh(): void; dispose(): void };
}

export interface InventoryView {
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly silk: number;
  readonly description: string;
  readonly canEquipSatellite: boolean;
  readonly kitName: string;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly health: number;
    readonly maxHealth: number;
    readonly remainingSeconds: number;
    readonly equipped: boolean;
  }[];
  readonly tools: readonly {
    readonly id: HaulerUtilityId | ScoutUtilityId;
    readonly name: string;
    readonly copy: string;
    readonly selected: boolean;
    readonly available: boolean;
  }[];
}
