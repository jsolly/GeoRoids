import type { Position, Velocity } from '../../../shared-types';
import {
  getHitSound,
  getLaserSound,
  playHitSound as playHitSoundAt,
  playLaserSound as playLaserSoundAt,
} from '../../audio/gameSounds';
import type { Sound } from '../../audio/Sound';
import { GAME, LASER } from '../../constants';
import { canvasManager } from '../../rendering/canvas';
import { getVelocityMagnitude } from '../../utils/mathUtils';

export interface LaserData {
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
    return this.distTraveled >= LASER.TRAVEL_DISTANCE_RATIO + cvs.width;
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
