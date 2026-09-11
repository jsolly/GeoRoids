import type { SatellitePickupData } from '../../../shared-types';
import { SatellitePickup } from './SatellitePickup';

export class SatellitePickupManager {
  private static instance: SatellitePickupManager;
  private pickups = new Map<string, SatellitePickup>();

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
    this.pickups.clear();
  }

  syncFromServer(list: SatellitePickupData[]): void {
    const seen = new Set(list.map((item) => item.id));
    for (const id of this.pickups.keys()) {
      if (!seen.has(id)) {
        this.pickups.delete(id);
      }
    }
    for (const data of list) {
      const existing = this.pickups.get(data.id);
      if (existing) {
        existing.updateFromServer(data);
      } else {
        this.pickups.set(data.id, new SatellitePickup(data));
      }
    }
  }
}
