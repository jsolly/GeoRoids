import type { SatellitePickupData } from '../../../shared-types';
import { SatellitePickup } from './SatellitePickup';

export const SATELLITE_INVENTORY_PAGE_SIZE = 24;

export class SatellitePickupManager {
  private static instance: SatellitePickupManager;
  private pickups = new Map<string, SatellitePickup>();
  private readonly owned = new Map<string, SatellitePickup[]>();
  private readonly equipped = new Map<string, SatellitePickup>();
  private readonly inventoryListeners = new Set<(owners: ReadonlySet<string>) => void>();

  subscribeInventory(listener: (owners: ReadonlySet<string>) => void): () => void {
    this.inventoryListeners.add(listener);
    return () => {
      this.inventoryListeners.delete(listener);
    };
  }

  getOwnedCount(ownerId: string): number {
    return this.owned.get(ownerId)?.length ?? 0;
  }

  getOwnedPage(ownerId: string, page: number): readonly SatellitePickup[] {
    const start = Math.max(0, Math.floor(page)) * SATELLITE_INVENTORY_PAGE_SIZE;
    return this.owned.get(ownerId)?.slice(start, start + SATELLITE_INVENTORY_PAGE_SIZE) ?? [];
  }

  getEquipped(ownerId: string): SatellitePickup | undefined {
    return this.equipped.get(ownerId);
  }

  private notifyInventory(owners: ReadonlySet<string>): void {
    for (const listener of this.inventoryListeners) {
      listener(owners);
    }
  }

  static getInstance(): SatellitePickupManager {
    if (!SatellitePickupManager.instance) {
      SatellitePickupManager.instance = new SatellitePickupManager();
    }
    return SatellitePickupManager.instance;
  }

  getAll(): SatellitePickup[] {
    return Array.from(this.pickups.values());
  }

  get(id: string): SatellitePickup | undefined {
    return this.pickups.get(id);
  }

  clear(): void {
    const owners = new Set(this.owned.keys());
    this.pickups.clear();
    this.owned.clear();
    this.equipped.clear();
    if (owners.size > 0) {
      this.notifyInventory(owners);
    }
  }

  syncFromServer(list: SatellitePickupData[]): void {
    const owners = new Set<string>();
    const markOwner = (pickup: Pick<SatellitePickupData, 'ownerId' | 'state'>) => {
      if (pickup.ownerId && (pickup.state === 'stored' || pickup.state === 'orbiting')) {
        owners.add(pickup.ownerId);
      }
    };
    const seen = new Set(list.map((item) => item.id));
    for (const id of this.pickups.keys()) {
      if (!seen.has(id)) {
        const removed = this.pickups.get(id);
        if (removed) {
          markOwner(removed);
        }
        this.pickups.delete(id);
      }
    }
    for (const data of list) {
      const existing = this.pickups.get(data.id);
      if (existing) {
        if (existing.ownerId !== data.ownerId || existing.state !== data.state) {
          markOwner(existing);
          markOwner(data);
        }
        existing.updateFromServer(data);
      } else {
        markOwner(data);
        this.pickups.set(data.id, new SatellitePickup(data));
      }
    }
    this.owned.clear();
    this.equipped.clear();
    for (const pickup of this.pickups.values()) {
      if (!pickup.ownerId || (pickup.state !== 'stored' && pickup.state !== 'orbiting')) {
        continue;
      }
      const rows = this.owned.get(pickup.ownerId);
      if (rows) {
        rows.push(pickup);
      } else {
        this.owned.set(pickup.ownerId, [pickup]);
      }
      if (pickup.state === 'orbiting') {
        this.equipped.set(pickup.ownerId, pickup);
      }
    }
    if (owners.size > 0) {
      this.notifyInventory(owners);
    }
  }
}
