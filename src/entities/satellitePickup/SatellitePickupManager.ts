import type { SatellitePickupData } from '../../../shared-types';
import { SatellitePickup } from './SatellitePickup';

export class SatellitePickupManager {
  private static instance: SatellitePickupManager;
  private pickups = new Map<string, SatellitePickup>();
  private lastCollectAttemptAt = new Map<string, number>();
  private static readonly COLLECT_RETRY_MS = 250;

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
    this.lastCollectAttemptAt.clear();
  }

  /** True when we should skip another collect packet for this loose pickup. */
  shouldDebounceCollect(id: string, now = Date.now()): boolean {
    const last = this.lastCollectAttemptAt.get(id);
    return last !== undefined && now - last < SatellitePickupManager.COLLECT_RETRY_MS;
  }

  markCollectAttempt(id: string, now = Date.now()): void {
    this.lastCollectAttemptAt.set(id, now);
  }

  syncFromServer(list: SatellitePickupData[]): void {
    const seen = new Set(list.map((item) => item.id));
    for (const id of this.pickups.keys()) {
      if (!seen.has(id)) {
        this.pickups.delete(id);
        this.lastCollectAttemptAt.delete(id);
      }
    }
    for (const data of list) {
      if (data.state !== 'loose') {
        this.lastCollectAttemptAt.delete(data.id);
      }
      const existing = this.pickups.get(data.id);
      if (existing) {
        existing.updateFromServer(data);
      } else {
        this.pickups.set(data.id, new SatellitePickup(data));
      }
    }
  }
}
