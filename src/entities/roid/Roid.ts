import type {
  AsteroidMaterial,
  AsteroidPhenomenon,
  Position,
  Velocity,
} from '../../../shared-types';
import { playHitSound as playHitSoundAt } from '../../audio/gameSounds';
import { DEBUG, GAME, ROID } from '../../constants';
import { stepAsteroidMotionInto } from '../../physics/asteroidMotion';

class Roid {
  id: string;
  angle: number;
  angularVelocity: number;
  offsets: number[] = [];
  vertices: number;
  velocity: Velocity;
  health: number;
  maxHealth: number;
  material?: AsteroidMaterial;
  /** Optional server-owned reflection metadata. */
  phenomenon?: AsteroidPhenomenon;
  spinClass?: 'natural' | 'charged';
  pendingDestruction: boolean = false; // Track asteroids waiting for server confirmation
  pendingUntilMs: number = 0;
  /** Shared multi-pilot HP rock. Lasers chip; do not pending-lock. */
  isCollabTarget: boolean = false;
  taggedUntil?: number; // Server-owned collab window; do not destroy locally while set
  private _jaggedness: number = ROID.JAGGEDNESS; // Store jaggedness value

  playHitSound(): void {
    playHitSoundAt(this.position);
  }

  constructor(
    public position: Position,
    public r: number,
    id?: string
  ) {
    this.id = id || crypto.randomUUID();
    this.angle = Math.random() * Math.PI * 2; // in radians
    this.angularVelocity = (Math.random() - 0.5) * 0.01; // Much smaller random rotation
    const speed = (Math.random() * ROID.SPEED) / GAME.FPS;
    this.velocity = {
      x: speed * (Math.random() < 0.5 ? 1 : -1),
      y: speed * (Math.random() < 0.5 ? 1 : -1),
    };

    this.vertices = Math.floor(Math.random() * (ROID.VERTICES + 1) + ROID.VERTICES / 2);
    this.health = this.r * 10; // Health based on size
    this.maxHealth = this.r * 10;

    this.generateShape();
  }

  get jaggedness(): number {
    return this._jaggedness;
  }

  set jaggedness(value: number) {
    this._jaggedness = value;
  }

  // Generate the shape based on current jaggedness
  private generateShape(): void {
    this.offsets.length = 0; // Clear existing offsets
    for (let i = 0; i < this.vertices; i++) {
      this.offsets.push(Math.random() * this._jaggedness * 2 + 1 - this._jaggedness);
    }
  }
}

class RoidBelt {
  roids: Roid[] = [];

  getRoids(): Roid[] {
    return this.roids;
  }

  moveRoids(tickScale = 1): void {
    // Freeze only when debug mode explicitly disables movement.
    // Production interpolates with a dt scale so 120 Hz tabs do not race
    // 60 Hz tabs (or the 60 FPS server) to the wrap/bounce edge.
    if (DEBUG.ENABLED && !DEBUG.ROIDS.MOVEMENT) {
      return;
    }

    for (const roid of this.roids) {
      stepAsteroidMotionInto(roid.position, roid.velocity, tickScale, roid.position, roid.velocity);
    }
  }
}

export { Roid, RoidBelt };
