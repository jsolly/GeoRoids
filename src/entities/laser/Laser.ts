import { ASTEROID_INTERACTIONS } from '../../../shared/asteroidPhenomena';
import { reflectVector } from '../../../shared/asteroidReflection';
import { findLaserSurfaceImpact } from '../../../shared/laserSurface';
import type { Position, Velocity } from '../../../shared-types';
import {
  getHitSound,
  getLaserSound,
  playHitSound as playHitSoundAt,
  playLaserSound as playLaserSoundAt,
} from '../../audio/gameSounds';
import type { Sound } from '../../audio/Sound';
import { GAME, LASER } from '../../constants';
import { canvasManager } from '../../rendering/canvasSurface';
import { getVelocityMagnitude } from '../../utils/mathUtils';

interface LaserData {
  position: Position;
  prevPosition: Position;
  serverId?: string;
  velocity: Velocity;
  distTraveled: number;
  explodeTime: number;
  hasExploded: boolean;
}

export class Laser implements LaserData {
  serverId?: string;
  bounceCount = 0;
  static get fxLaser(): Sound {
    return getLaserSound();
  }
  static get fxHit(): Sound {
    return getHitSound();
  }
  prevPosition: Position;

  constructor(
    public position: Position,
    public velocity: Velocity,
    public distTraveled: number,
    public explodeTime: number,
    public hasExploded: boolean = false
  ) {
    this.prevPosition = { x: position.x, y: position.y };
  }

  move(): void {
    if (this.explodeTime > 0) {
      this.explodeTime--;
    } else {
      this.prevPosition = { x: this.position.x, y: this.position.y };
      this.position = {
        x: this.position.x + this.velocity.x,
        y: this.position.y + this.velocity.y,
      };
      const speed = getVelocityMagnitude(this.velocity);
      let remaining = speed;
      for (let work = 0; work <= ASTEROID_INTERACTIONS.maxBounces; work++) {
        const impact = findLaserSurfaceImpact(this.prevPosition, this.position);
        if (!impact) {
          break;
        }
        if (this.bounceCount >= ASTEROID_INTERACTIONS.maxBounces) {
          this.hasExploded = true;
          this.position = impact.point;
          break;
        }
        this.velocity = reflectVector(this.velocity, impact.normal);
        remaining = Math.max(0, remaining - impact.distance);
        this.prevPosition = {
          x: impact.point.x - impact.normal.x * 1e-5,
          y: impact.point.y - impact.normal.y * 1e-5,
        };
        this.position = {
          x: this.prevPosition.x + (this.velocity.x / speed) * remaining,
          y: this.prevPosition.y + (this.velocity.y / speed) * remaining,
        };
        this.bounceCount++;
      }
      this.distTraveled += getVelocityMagnitude(this.velocity);
    }
  }

  updateExplodeTime(): void {
    this.explodeTime = Math.ceil(LASER.EXPLODE_DURATION * GAME.FPS);
    this.hasExploded = true;
  }

  isExpired(): boolean {
    const cvs = canvasManager.getCanvas();
    if (!cvs) {
      return true; // Expire immediately if canvas is unavailable
    }
    return this.distTraveled >= LASER.TRAVEL_DISTANCE_RATIO + canvasManager.getViewportSize().width;
  }

  shouldBeRemoved(): boolean {
    // Remove if traveled max distance OR finished exploding
    return this.isExpired() || (this.hasExploded && this.explodeTime <= 0);
  }

  playLaserSound(): void {
    playLaserSoundAt(this.position);
  }

  playHitSound(): void {
    playHitSoundAt(this.position);
  }
}
