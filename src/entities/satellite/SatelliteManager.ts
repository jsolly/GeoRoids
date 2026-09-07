import type { Position, SatelliteData, Velocity } from '../../../shared-types';
import { entityFactory } from '../EntityFactory';
import { Satellite } from './Satellite';

export interface SatelliteProjectileSnapshot {
  satelliteId: string;
  shotId: string;
  position: Position;
  velocity: Velocity;
  age: number;
}

export class SatelliteManager {
  private static instance: SatelliteManager;
  private satellites = new Map<string, Satellite>();
  private activeShotIds = new Set<string>();

  static getInstance(): SatelliteManager {
    if (!SatelliteManager.instance) {
      SatelliteManager.instance = new SatelliteManager();
    }
    return SatelliteManager.instance;
  }

  getAll(): Satellite[] {
    return Array.from(this.satellites.values());
  }

  get(id: string): Satellite | undefined {
    return this.satellites.get(id);
  }

  clear(): void {
    this.satellites.clear();
    this.activeShotIds.clear();
  }

  syncFromServer(list: SatelliteData[]): void {
    const seen = new Set(list.map((item) => item.id));
    for (const id of this.satellites.keys()) {
      if (!seen.has(id)) {
        const satellite = this.satellites.get(id);
        if (satellite) {
          for (const laser of satellite.lasers) {
            const shotId = satellite.getShotId(laser);
            if (shotId) {
              this.activeShotIds.delete(shotId);
            }
          }
        }
        this.satellites.delete(id);
      }
    }
    for (const data of list) {
      const existing = this.satellites.get(data.id);
      if (existing) {
        if (data.exploding || data.health <= 0) {
          for (const laser of existing.lasers) {
            const shotId = existing.getShotId(laser);
            if (shotId) {
              this.activeShotIds.delete(shotId);
            }
          }
          existing.lasers.length = 0;
        }
        existing.updateFromServer(data);
      } else {
        this.satellites.set(data.id, new Satellite(data));
      }
    }
  }

  addLaser(satelliteId: string, shotId: string, position: Position, velocity: Velocity): void {
    if (!shotId || this.activeShotIds.has(shotId)) {
      return;
    }
    const satellite = this.satellites.get(satelliteId);
    if (!satellite || satellite.exploding || satellite.health <= 0) {
      return;
    }
    satellite.addLaser(
      entityFactory.createLaser({
        position: { ...position },
        velocity: { ...velocity },
        distTraveled: 0,
        explodeTime: 0,
        hasExploded: false,
      }),
      shotId
    );
    this.activeShotIds.add(shotId);
  }

  /** Apply a complete server keyframe without duplicating live shot events. */
  syncProjectilesFromServer(projectiles: readonly SatelliteProjectileSnapshot[]): void {
    const snapshotShotIds = new Set<string>();
    const validProjectiles: SatelliteProjectileSnapshot[] = [];
    for (const projectile of projectiles) {
      if (
        typeof projectile.satelliteId !== 'string' ||
        projectile.satelliteId.length === 0 ||
        typeof projectile.shotId !== 'string' ||
        projectile.shotId.length === 0 ||
        !Number.isFinite(projectile.position?.x) ||
        !Number.isFinite(projectile.position?.y) ||
        !Number.isFinite(projectile.velocity?.x) ||
        !Number.isFinite(projectile.velocity?.y) ||
        !Number.isFinite(projectile.age) ||
        projectile.age < 0 ||
        snapshotShotIds.has(projectile.shotId)
      ) {
        continue;
      }
      snapshotShotIds.add(projectile.shotId);
      validProjectiles.push(projectile);
    }

    for (const satellite of this.satellites.values()) {
      for (const laser of [...satellite.lasers]) {
        const shotId = satellite.getShotId(laser);
        if (shotId && !snapshotShotIds.has(shotId)) {
          satellite.removeLaserByShotId(shotId);
          this.activeShotIds.delete(shotId);
        }
      }
    }

    for (const projectile of validProjectiles) {
      const satellite = this.satellites.get(projectile.satelliteId);
      if (!satellite) {
        continue;
      }
      if (
        !satellite.syncLaserFromServer(
          projectile.shotId,
          projectile.position,
          projectile.velocity,
          projectile.age
        )
      ) {
        this.addLaser(
          projectile.satelliteId,
          projectile.shotId,
          projectile.position,
          projectile.velocity
        );
        satellite.syncLaserFromServer(
          projectile.shotId,
          projectile.position,
          projectile.velocity,
          projectile.age
        );
      }
    }
  }

  update(): void {
    for (const satellite of this.satellites.values()) {
      for (const shotId of satellite.update()) {
        this.activeShotIds.delete(shotId);
      }
    }
  }
}
