import type { SatelliteShotManner, SatelliteTypeId } from '../../../shared/eoSatellites';
import type { Position, SatelliteData, Velocity } from '../../../shared-types';
import { SATELLITE } from '../../constants';
import type { Laser } from '../laser/Laser';

export class Satellite {
  id: string;
  name: string;
  typeId: SatelliteTypeId;
  assetKey: string;
  shotManner: SatelliteShotManner;
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  color: string;
  health: number;
  maxHealth: number;
  radius: number;
  explodeTime: number;
  lasers: Laser[] = [];
  private readonly laserShotIds = new WeakMap<Laser, string>();
  private readonly laserAges = new WeakMap<Laser, number>();

  constructor(data: SatelliteData) {
    this.id = data.id;
    this.name = data.name;
    this.typeId = data.typeId;
    this.assetKey = data.assetKey;
    this.shotManner = data.shotManner;
    this.position = { ...data.position };
    this.velocity = { ...data.velocity };
    this.angle = data.angle;
    this.exploding = data.exploding;
    this.color = data.color;
    this.health = data.health;
    this.maxHealth = data.maxHealth;
    this.radius = data.radius;
    this.explodeTime = data.exploding ? SATELLITE.EXPLODE_DURATION_FRAMES : 0;
  }

  updateFromServer(data: SatelliteData): void {
    this.name = data.name;
    this.typeId = data.typeId;
    this.assetKey = data.assetKey;
    this.shotManner = data.shotManner;
    this.position = { ...data.position };
    this.velocity = { ...data.velocity };
    this.angle = data.angle;
    this.color = data.color;
    this.health = data.health;
    this.maxHealth = data.maxHealth;
    this.radius = data.radius;
    if (data.exploding && !this.exploding) {
      this.explodeTime = SATELLITE.EXPLODE_DURATION_FRAMES;
    }
    this.exploding = data.exploding;
  }

  addLaser(laser: Laser, shotId: string): void {
    this.lasers.push(laser);
    this.laserShotIds.set(laser, shotId);
    this.laserAges.set(laser, 0);
  }

  getShotId(laser: Laser): string | undefined {
    return this.laserShotIds.get(laser);
  }

  getLaserByShotId(shotId: string): Laser | undefined {
    for (const laser of this.lasers) {
      if (this.laserShotIds.get(laser) === shotId) {
        return laser;
      }
    }
    return undefined;
  }

  removeLaserByShotId(shotId: string): boolean {
    const index = this.lasers.findIndex((laser) => this.laserShotIds.get(laser) === shotId);
    if (index < 0) {
      return false;
    }
    this.lasers.splice(index, 1);
    return true;
  }

  syncLaserFromServer(
    shotId: string,
    position: Position,
    velocity: Velocity,
    age: number
  ): boolean {
    const laser = this.getLaserByShotId(shotId);
    if (!laser) {
      return false;
    }
    laser.prevPosition = { ...position };
    laser.position = { ...position };
    laser.velocity = { ...velocity };
    laser.distTraveled = Math.max(0, age) * Math.hypot(velocity.x, velocity.y);
    this.laserAges.set(laser, Math.max(0, age));
    laser.explodeTime = 0;
    laser.hasExploded = false;
    return true;
  }

  update(): string[] {
    const removedShotIds = this.moveLasers();
    if (this.exploding && this.explodeTime > 0) {
      this.explodeTime -= 1;
    }
    return removedShotIds;
  }

  private moveLasers(): string[] {
    const removedShotIds: string[] = [];
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const laser = this.lasers[i];
      if (laser === undefined) {
        continue;
      }
      laser.move();
      const age = (this.laserAges.get(laser) ?? 0) + 1;
      this.laserAges.set(laser, age);
      if (age > SATELLITE.PROJECTILE_MAX_FRAMES || (laser.hasExploded && laser.explodeTime <= 0)) {
        const shotId = this.laserShotIds.get(laser);
        if (shotId) {
          removedShotIds.push(shotId);
        }
        this.lasers.splice(i, 1);
      }
    }
    return removedShotIds;
  }
}
